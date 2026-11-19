# syntax=docker/dockerfile:1

ARG BUN_VERSION=1
ARG MEDIAMTX_VERSION=1.21.4

# Own stage so curl and the archive never reach the final image, and so later
# stages (detector, -nvidia variant) can reuse or replace it independently.
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

FROM oven/bun:${BUN_VERSION}-slim AS base
# tini is PID 1: it forwards SIGTERM/SIGINT to the main process and reaps
# orphaned ffmpeg/mediamtx children, which Bun as PID 1 would not.
# Debian's ffmpeg is linked against libavfilter, which drags in Mesa and LLVM through libplacebo
# and Vulkan. They are only dlopen'ed for GPU filters and hwaccel, neither of which recording,
# snapshots or probing use, so they are purged (about 180 MB). --force-depends leaves dpkg's
# dependency state inconsistent: do not run apt-get install in this stage after this layer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
 && dpkg --purge --force-depends libllvm19 mesa-libgallium libz3-4 \
 && ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=d=1 -f lavfi -i sine=d=1 \
      -c:v libx264 -c:a aac -f null - \
 && ffprobe -hide_banner -loglevel error -version >/dev/null \
 && rm -rf /var/lib/apt/lists/*
COPY --from=mediamtx /dl/mediamtx /usr/local/bin/mediamtx

WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --production --frozen-lockfile
COPY src ./src
COPY web ./web

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8765 \
    RTSP_PORT=8554
VOLUME /data
EXPOSE 8765 8554

# Slim images have no curl; use the bundled runtime instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.PORT}/api/info`); process.exit(r.ok ? 0 : 1)"]

ENTRYPOINT ["tini", "-g", "--"]
CMD ["bun", "run", "src/main.ts"]
