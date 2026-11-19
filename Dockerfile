# syntax=docker/dockerfile:1

ARG BUN_VERSION=1
ARG MEDIAMTX_VERSION=1.21.4
# default：CPU 推論，amd64 另含 Intel 內顯（OpenVINO）；nvidia：CPU、Intel 內顯與 Nvidia（CUDA 12），只有 amd64。
ARG VARIANT=default

# Own stage so curl and the archive never reach the final image.
FROM debian:bookworm-slim AS mediamtx
ARG MEDIAMTX_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /dl
# dpkg's arch names (amd64, arm64) match MediaMTX's asset names, and unlike
# TARGETARCH they are also set under the legacy (non-BuildKit) builder.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    base="https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}"; \
    file="mediamtx_v${MEDIAMTX_VERSION}_linux_${arch}.tar.gz"; \
    curl -fsSL --retry 3 -O "${base}/${file}" -O "${base}/checksums.sha256"; \
    grep "[ *]${file}\$" checksums.sha256 | sha256sum -c -; \
    tar -xzf "${file}" mediamtx

# The detector's Python environment, the built-in YOLOX model and the state classification backbone (DINOv2-small). Same base image as the final stage, so the
# venv's bin/python symlink resolves to the same /usr/bin/python3 (3.13) there.
FROM oven/bun:${BUN_VERSION}-slim AS detector
ARG VARIANT
# CUDA 13 instead of the pinned CUDA 12 set, e.g. "onnxruntime-gpu[cuda,cudnn]==1.32.0" (needs driver 580+, Turing or newer).
ARG ONNXRUNTIME_GPU=
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY detector/requirements.txt detector/requirements-nvidia.txt detector/builtin-model.json detector/backbone-model.json detector/fetch_model.py /src/
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$VARIANT" in \
      default) req=/src/requirements.txt ;; \
      nvidia) \
        if [ "$arch" != amd64 ]; then \
          echo "VARIANT=nvidia 只支援 linux/amd64（onnxruntime-gpu 與 CUDA 函式庫沒有 ${arch} 版）；${arch} 請建預設變體。" >&2; exit 1; \
        fi; \
        req=/src/requirements-nvidia.txt; \
        if [ -n "$ONNXRUNTIME_GPU" ]; then \
          grep -viE '^(onnxruntime-gpu|nvidia-)' "$req" > /tmp/requirements.txt; \
          echo "$ONNXRUNTIME_GPU" >> /tmp/requirements.txt; \
          req=/tmp/requirements.txt; \
        fi ;; \
      *) echo "VARIANT 只能是 default 或 nvidia，收到 ${VARIANT}" >&2; exit 1 ;; \
    esac; \
    python3 -m venv /opt/detector; \
    /opt/detector/bin/pip install --no-cache-dir --disable-pip-version-check -r "$req"; \
    /opt/detector/bin/pip uninstall -y --disable-pip-version-check pip; \
    python3 /src/fetch_model.py /models

# The web UI (React, built by Vite). Only dist/web reaches the final image, not the frontend packages.
FROM oven/bun:${BUN_VERSION}-slim AS web
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY web ./web
RUN bun run build

FROM oven/bun:${BUN_VERSION}-slim AS base
ARG VARIANT
# tini is PID 1: it forwards SIGTERM/SIGINT to the main process and reaps
# orphaned ffmpeg/mediamtx children, which Bun as PID 1 would not.
# Debian's ffmpeg is linked against libavfilter, which drags in Mesa and LLVM through libplacebo
# and Vulkan. They are only dlopen'ed for GPU filters and hwaccel, neither of which recording,
# snapshots or probing use, so they are purged (about 180 MB). --force-depends leaves dpkg's
# dependency state inconsistent: do not run apt-get install in this stage after this layer.
# Intel's OpenCL runtime for OpenVINO's GPU plugin (both variants on amd64: an Nvidia box often has an
# Intel iGPU too) is installed in the same layer so the .deb files
# never land in one. Trixie does not package it. The GPU plugin links only libOpenCL, so the Level Zero
# drivers are left out. Two generations side by side, as Frigate does:
# 26.40 covers Gen12 and newer (Tiger Lake, Alder Lake, N100, Arc); the legacy1 24.35 packages cover
# Gen8 to Gen11 (Skylake to Ice Lake, Apollo/Gemini Lake), which current releases dropped.
# They install side by side (separate ICD files, IGC 1.x vs 2.x sonames); the OpenCL loader picks
# whichever claims the GPU. Hashes are the GitHub release asset digests, cross-checked with ww40.sum
# and ww35.sum. Slim images have no curl; bun downloads them.
# Hardware video decode (detect worker, settings.devices.decode): Intel goes through VA-API, so amd64
# gets the iHD driver (Gen8 and newer) and i965 (older), in both variants since an Nvidia box usually
# has an Intel iGPU too. Debian's ffmpeg already has VAAPI and NVDEC/NVENC (it dlopens libcuda and
# libnvcuvid, which the NVIDIA Container Toolkit mounts when NVIDIA_DRIVER_CAPABILITIES includes video).
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    intel=""; va=""; \
    if [ "$arch" = amd64 ]; then intel=ocl-icd-libopencl1; fi; \
    if [ "$arch" = amd64 ]; then va="intel-media-va-driver i965-va-driver"; fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends ffmpeg tini ca-certificates python3 $intel $va; \
    if [ -n "$intel" ]; then \
      mkdir /tmp/intel-gpu; cd /tmp/intel-gpu; \
      cr=https://github.com/intel/compute-runtime/releases/download; \
      igc=https://github.com/intel/intel-graphics-compiler/releases/download; \
      set -- \
        053fceadb84a1d2f9a30a0d1bc9b16424b3f1a90cc49900fcd80aadcf25c8a4d "$cr/26.40.40196.8/libigdgmm12_22.10.2_amd64.deb" \
        96046069e94680b761df6e83ddc64244721178b826e3e1f8af3ca104cfd0c7c2 "$cr/26.40.40196.8/intel-opencl-icd_26.40.40196.8-0_amd64.deb" \
        e20539632f2d99875d8f8b225d5da58b31f98baa54bb47c6328aa98ec473ab9d "$igc/v2.42.6/intel-igc-core-2_2.42.6+23070_amd64.deb" \
        7f5593cf828503ffb8450967768bde9209e22753bc576296e846b5a751011fa3 "$igc/v2.42.6/intel-igc-opencl-2_2.42.6+23070_amd64.deb" \
        bbe71e4f414259e06a10cde72c29a2bd78d41b2bb2f6f8463b1806797fe66e85 "$cr/24.35.30872.36/intel-opencl-icd-legacy1_24.35.30872.36_amd64.deb" \
        c1e1ecdfe2064c047c552651cfdcdafc504f2033afafba65654338b880048b67 "$igc/igc-1.0.17537.24/intel-igc-core_1.0.17537.24_amd64.deb" \
        dd016400f87fa2b6a9fa9fbcca7eb4a2629174a29de679709f9bec5cede88b0e "$igc/igc-1.0.17537.24/intel-igc-opencl_1.0.17537.24_amd64.deb"; \
      while [ $# -gt 0 ]; do \
        URL="$2" OUT="${2##*/}" bun -e 'const r = await fetch(process.env.URL); if (!r.ok) throw new Error(`${r.status} ${process.env.URL}`); await Bun.write(process.env.OUT, r);'; \
        echo "$1  ${2##*/}" | sha256sum -c -; \
        shift 2; \
      done; \
      apt-get install -y --no-install-recommends ./*.deb; \
      cd /; rm -rf /tmp/intel-gpu; \
    fi; \
    dpkg --purge --force-depends libllvm19 mesa-libgallium libz3-4; \
    ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=d=1 -f lavfi -i sine=d=1 \
      -c:v libx264 -c:a aac -f null -; \
    ffprobe -hide_banner -loglevel error -version >/dev/null; \
    if [ -n "$va" ]; then test -f /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so; test -f /usr/lib/x86_64-linux-gnu/dri/i965_drv_video.so; fi; \
    rm -rf /var/lib/apt/lists/*
COPY --from=mediamtx /dl/mediamtx /usr/local/bin/mediamtx
COPY --from=detector /opt/detector /opt/detector
RUN /opt/detector/bin/python -B -c "import onnxruntime, numpy, PIL; print('onnxruntime', onnxruntime.__version__, onnxruntime.get_available_providers())"

WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --production --frozen-lockfile
COPY detector ./detector
COPY --from=detector /models ./detector/models
COPY scripts/detector-selftest scripts/video-selftest scripts/video-selftest.ts scripts/docker-entrypoint ./scripts/
RUN chmod +x scripts/detector-selftest scripts/video-selftest scripts/docker-entrypoint \
 && ln -s /app/scripts/detector-selftest /usr/local/bin/detector-selftest \
 && ln -s /app/scripts/video-selftest /usr/local/bin/video-selftest
COPY src ./src
# The fMP4 parser is shared: the server imports it for live view and HomeKit.
COPY web/playback/mp4.ts ./web/playback/mp4.ts
COPY --from=web /build/dist/web ./dist/web

# The detector only starts when object detection is enabled in settings.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8765 \
    RTSP_PORT=8554 \
    DETECTOR_PYTHON=/opt/detector/bin/python \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility,video
# /recordings is deliberately not declared as a volume: an anonymous volume would look
# like a real mount and silently take the recordings, then vanish with the container.
VOLUME /data
EXPOSE 8765 8554

# Slim images have no curl; use the bundled runtime instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.PORT}/api/info`); process.exit(r.ok ? 0 : 1)"]

# PUID／PGID／UMASK：見 scripts/docker-entrypoint。它 exec 主程序，tini 的訊號仍直接送到 bun。
ENTRYPOINT ["tini", "-g", "--", "/app/scripts/docker-entrypoint"]
CMD ["bun", "run", "src/main.ts"]
