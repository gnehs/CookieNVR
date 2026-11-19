"""列出推論裝置、載入模型、測速。

裝置的實作只有 ONNX Runtime 的 execution provider：
- cpu：CPUExecutionProvider（所有映像都有）
- intel：OpenVINO plugin EP（`onnxruntime-ep-openvino`，只有 amd64 預設映像），OpenVINO 的 GPU.0、GPU.1…，需要 /dev/dri
- nvidia：CUDAExecutionProvider（`onnxruntime-gpu`，只有 -nvidia 映像），每張卡一個裝置，需要 NVIDIA Container Toolkit

每個裝置有穩定的識別字，設定存的是它而不是清單順序：
- cpu
- intel:GPU.0（OpenVINO 的裝置名稱；內顯只有一顆時固定是 GPU.0）
- nvidia:GPU-<uuid>（nvidia-smi 的 UUID，換插槽或重開機都不變；沒有 nvidia-smi 時退而用 nvidia:<編號>）

指定的或自動選到的 GPU 載入失敗時退回 CPU；指定的裝置不見了改用自動；原因寫進 LoadResult.fallback。
"""

from __future__ import annotations

import glob
import io
import os
import platform
import statistics
import subprocess
import time
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

import yolo

# CUDA 預設把最快的卡排第 0 張；改成 PCI 順序才會和 nvidia-smi 的編號一致
os.environ.setdefault("CUDA_DEVICE_ORDER", "PCI_BUS_ID")

KINDS = ("cpu", "intel", "nvidia")
KIND_NAMES = {"cpu": "CPU", "intel": "Intel 內顯", "nvidia": "Nvidia 顯卡"}


@dataclass(frozen=True)
class Fallback:
    #: 給使用者看的中文
    reason: str
    #: 給開發者的技術細節（例外訊息等）
    detail: str = ""

    def to_json(self) -> dict:
        return {"reason": self.reason, "detail": self.detail}


@dataclass(frozen=True)
class Device:
    id: str
    kind: str
    name: str
    #: nvidia：CUDA device_id（PCI 順序）
    index: int = 0
    #: intel：OpenVINO 的裝置名稱，例如 GPU.0
    ov_device: str | None = None

    def to_json(self) -> dict:
        return {"id": self.id, "kind": self.kind, "name": self.name}


@dataclass
class Probe:
    """這個環境有哪些推論元件與裝置。"""

    ort_version: str
    providers: list[str]
    openvino_plugin: str | None  # plugin 函式庫路徑；沒有安裝為 None
    openvino_plugin_error: str | None
    dri_nodes: list[str]
    dri_accessible: bool
    nvidia_nodes: list[str]
    devices: list[Device] = field(default_factory=list)
    #: 列舉某類裝置時遇到的錯誤（例如 OpenVINO 看不到 GPU）
    enum_errors: dict[str, str] = field(default_factory=dict)

    @property
    def has_cuda(self) -> bool:
        return "CUDAExecutionProvider" in self.providers

    @property
    def has_openvino(self) -> bool:
        return self.openvino_plugin is not None

    def of_kind(self, kind: str) -> list[Device]:
        return [d for d in self.devices if d.kind == kind]

    def find(self, device_id: str) -> Device | None:
        return next((d for d in self.devices if d.id == device_id), None)

    def to_json(self) -> dict:
        return {
            "ortVersion": self.ort_version,
            "providers": self.providers,
            "openvinoPlugin": self.openvino_plugin is not None,
            "dri": self.dri_nodes,
            "nvidia": self.nvidia_nodes,
            "devices": [d.to_json() for d in self.devices],
            "enumErrors": self.enum_errors,
        }


def sh(cmd: list[str], timeout: float = 10) -> str | None:
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.strip() if out.returncode == 0 and out.stdout.strip() else None


def cpu_name() -> str:
    try:
        with open("/proc/cpuinfo", encoding="utf-8") as f:
            for line in f:
                if line.startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    if platform.system() == "Darwin":
        return sh(["sysctl", "-n", "machdep.cpu.brand_string"]) or platform.machine()
    return platform.processor() or platform.machine()


def _register_openvino(ort, plugin_path: str) -> None:
    if not any(d.ep_name == "OpenVINOExecutionProvider" for d in ort.get_ep_devices()):
        ort.register_execution_provider_library("openvino", plugin_path)


def _intel_devices(ort, p: Probe) -> list[Device]:
    _register_openvino(ort, p.openvino_plugin)  # type: ignore[arg-type]
    found = []
    for d in ort.get_ep_devices():
        if d.ep_name != "OpenVINOExecutionProvider":
            continue
        ov = str(d.ep_metadata.get("ov_device", ""))
        if not ov.startswith("GPU"):
            continue
        meta = {**dict(d.device.metadata), **dict(d.ep_metadata)}
        name = next((str(v) for k, v in meta.items() if "name" in k.lower() or "description" in k.lower()), "")
        found.append(Device(f"intel:{ov}", "intel", name or f"Intel 內顯（{ov}）", ov_device=ov))
    return found


def _nvidia_devices(p: Probe) -> list[Device]:
    out = sh(["nvidia-smi", "--query-gpu=index,uuid,name", "--format=csv,noheader"])
    if out:
        found = []
        for line in out.splitlines():
            parts = [x.strip() for x in line.split(",", 2)]
            if len(parts) == 3 and parts[0].isdigit():
                found.append(Device(f"nvidia:{parts[1]}", "nvidia", parts[2], index=int(parts[0])))
        if found:
            return found
    return [Device(f"nvidia:{i}", "nvidia", f"Nvidia 顯卡 {i}", index=i) for i in range(len(p.nvidia_nodes))]


def probe(ort) -> Probe:
    plugin_path, plugin_error = None, None
    try:
        import onnxruntime_ep_openvino as ov  # type: ignore[import-not-found]

        plugin_path = ov.get_library_path()
    except ImportError:
        pass
    except Exception as e:  # noqa: BLE001 — 套件壞掉也只是沒有 Intel 可用
        plugin_error = f"{type(e).__name__}: {e}"
    dri = sorted(glob.glob("/dev/dri/renderD*"))
    p = Probe(
        ort_version=ort.__version__,
        providers=list(ort.get_available_providers()),
        openvino_plugin=plugin_path,
        openvino_plugin_error=plugin_error,
        dri_nodes=dri,
        dri_accessible=bool(dri) and all(os.access(n, os.R_OK | os.W_OK) for n in dri),
        nvidia_nodes=sorted(n for n in glob.glob("/dev/nvidia*") if os.path.basename(n)[6:].isdigit()),
    )
    p.devices.append(Device("cpu", "cpu", cpu_name()))
    if unavailable_reason("nvidia", p) is None:
        p.devices.extend(_nvidia_devices(p))
    if unavailable_reason("intel", p) is None:
        try:
            intel = _intel_devices(ort, p)
            if not intel:
                p.enum_errors["intel"] = "OpenVINO 沒有列出任何 GPU 裝置"
            p.devices.extend(intel)
        except Exception as e:  # noqa: BLE001
            p.enum_errors["intel"] = f"{type(e).__name__}: {e}"[:400]
    return p


def unavailable_reason(kind: str, p: Probe) -> Fallback | None:
    """這一類裝置在此環境明顯不能用的原因；看起來可以試就回 None。"""
    if kind == "intel":
        if not p.has_openvino:
            detail = p.openvino_plugin_error or "onnxruntime-ep-openvino 沒有安裝"
            return Fallback("這個映像沒有 Intel 內顯推論元件（只有 amd64 的 latest 映像有）", detail)
        if not p.dri_nodes:
            return Fallback("容器裡找不到 Intel 內顯（/dev/dri），請在容器設定掛入 /dev/dri", "no /dev/dri/renderD*")
        if not p.dri_accessible:
            return Fallback("沒有權限使用 /dev/dri，請把容器加入主機 render 群組（--group-add）", f"{p.dri_nodes} not readable/writable")
        if p.devices and not p.of_kind("intel") and "intel" in p.enum_errors:
            return Fallback("OpenVINO 看不到 Intel 內顯，可能是驅動不支援這顆內顯", p.enum_errors["intel"])
    if kind == "nvidia":
        if not p.has_cuda:
            return Fallback("這個映像沒有 Nvidia 推論元件，請改用 latest-nvidia 映像", f"providers={p.providers}")
        if not p.nvidia_nodes:
            return Fallback(
                "容器裡看不到 Nvidia 顯卡，請確認主機已裝 NVIDIA Container Toolkit，並以 --gpus all 或 runtime: nvidia 啟動",
                "no /dev/nvidia[0-9]",
            )
    return None


def auto_candidates(p: Probe) -> list[Device]:
    """自動模式的嘗試順序：Nvidia、Intel、CPU。"""
    return [*p.of_kind("nvidia"), *p.of_kind("intel"), *p.of_kind("cpu")]


def resolve(requested: str, p: Probe) -> tuple[list[Device], Fallback | None]:
    """要求的裝置 → 依序嘗試的裝置與（已知的）退回原因。requested 可以是 auto、cpu、裝置識別字，或 intel／nvidia（該類的第一個）。"""
    cpu = p.of_kind("cpu")
    if requested == "auto":
        return auto_candidates(p), None
    if requested == "cpu":
        return cpu, None
    if requested in ("intel", "nvidia"):
        found = p.of_kind(requested)
        if found:
            return [found[0], *cpu], None
        reason = unavailable_reason(requested, p) or Fallback(f"沒有偵測到{KIND_NAMES[requested]}", "")
        return cpu, reason
    device = p.find(requested)
    if device:
        return [device, *cpu], None
    kind = requested.split(":", 1)[0]
    reason = unavailable_reason(kind, p) if kind in KINDS else None
    if reason is None:
        reason = Fallback(f"指定的裝置目前找不到（可能已拔除或換了顯示卡），已改用自動選擇", requested)
    return auto_candidates(p), reason


def cpu_threads() -> int:
    # 錄影與偵測也要用 CPU，推論最多用一半的核心、上限 4
    return max(1, min(4, (os.cpu_count() or 2) // 2))


def _session_options(ort):
    so = ort.SessionOptions()
    so.intra_op_num_threads = cpu_threads()
    so.inter_op_num_threads = 1
    so.log_severity_level = 3
    return so


def create_session(ort, model_path: str, device: Device, p: Probe):
    """建立 InferenceSession；確認實際用的是要求的 provider，否則丟例外讓呼叫端退回 CPU。"""
    so = _session_options(ort)
    if device.kind == "cpu":
        return ort.InferenceSession(model_path, sess_options=so, providers=["CPUExecutionProvider"])
    if device.kind == "nvidia":
        preload = getattr(ort, "preload_dlls", None)
        if preload is not None:
            # pip 裝的 CUDA／cuDNN 函式庫不在系統路徑上，要先載入
            preload()
        sess = ort.InferenceSession(
            model_path, sess_options=so, providers=[("CUDAExecutionProvider", {"device_id": device.index}), "CPUExecutionProvider"]
        )
        if sess.get_providers()[0] != "CUDAExecutionProvider":
            raise RuntimeError(f"CUDA provider 沒有啟用（實際 providers={sess.get_providers()}），通常是 CUDA／cuDNN 函式庫或主機驅動不相容")
        return sess
    if device.kind == "intel":
        _register_openvino(ort, p.openvino_plugin)  # type: ignore[arg-type]
        match = [d for d in ort.get_ep_devices() if d.ep_name == "OpenVINOExecutionProvider" and d.ep_metadata.get("ov_device") == device.ov_device]
        if not match:
            raise RuntimeError(f"OpenVINO 找不到 {device.ov_device}，通常是缺少 Intel GPU 驅動或沒掛入 /dev/dri")
        so.add_provider_for_devices([match[0]], {"cache_dir": os.environ.get("OPENVINO_CACHE_DIR", "/tmp/cookienvr-openvino")})
        return ort.InferenceSession(model_path, sess_options=so)
    raise ValueError(f"unknown device kind {device.kind}")


@dataclass
class Engine:
    session: object
    layout: yolo.Layout
    device: Device
    input_name: str
    providers: list[str] = field(default_factory=list)

    def infer_image(self, image: Image.Image, min_score: float = yolo.MIN_SCORE) -> list[yolo.Detection]:
        tensor, box = yolo.preprocess(image, self.layout)
        (output,) = self.session.run(None, {self.input_name: tensor})[:1]
        return yolo.postprocess(np.asarray(output), self.layout, box, min_score)

    def infer_jpeg(self, jpeg: bytes, min_score: float = yolo.MIN_SCORE) -> list[yolo.Detection]:
        image = Image.open(io.BytesIO(jpeg))
        image.draft("RGB", (self.layout.width, self.layout.height))
        return self.infer_image(image, min_score)


def build_engine(ort, model_path: str, device: Device, p: Probe) -> Engine:
    """建立 session、跑一次空白畫面判斷輸出格式。格式不合丟 ModelFormatError，裝置問題丟其他例外。"""
    session = create_session(ort, model_path, device, p)
    inputs = session.get_inputs()
    if len(inputs) != 1:
        raise yolo.ModelFormatError(f"模型應該只有一個影像輸入，這個模型有 {len(inputs)} 個")
    width, height = yolo.input_size(list(inputs[0].shape))
    if inputs[0].type != "tensor(float)":
        raise yolo.ModelFormatError(f"模型的輸入型別是 {inputs[0].type}，目前只支援 float32")
    dummy = np.full((1, 3, height, width), yolo.PAD_VALUE, dtype=np.float32)
    outputs = session.run(None, {inputs[0].name: dummy})
    metadata = dict(session.get_modelmeta().custom_metadata_map)
    layout = yolo.detect_layout(list(inputs[0].shape), tuple(np.asarray(outputs[0]).shape), metadata)
    return Engine(session, layout, device, inputs[0].name, list(session.get_providers()))


@dataclass
class LoadResult:
    engine: Engine
    requested: str
    fallback: Fallback | None
    load_ms: int
    #: 每個嘗試過的裝置的結果，給診斷用
    attempts: list[dict]


def load(ort, model_path: str, requested: str, p: Probe | None = None) -> LoadResult:
    """依要求的裝置載入；GPU 失敗退回 CPU。模型本身不合格式直接丟 ModelFormatError（換裝置也沒用）。"""
    p = p or probe(ort)
    candidates, fallback = resolve(requested, p)
    attempts: list[dict] = []
    if fallback:
        attempts.append({"device": requested, "ok": False, "error": fallback.detail or fallback.reason})
    started = time.monotonic()
    for device in candidates:
        t0 = time.monotonic()
        try:
            engine = build_engine(ort, model_path, device, p)
        except yolo.ModelFormatError:
            raise
        except Exception as e:  # noqa: BLE001 — 任何 GPU 載入錯誤都退回下一個
            if device.kind == "cpu":
                raise
            err = f"{type(e).__name__}: {e}"
            attempts.append({"device": device.id, "ok": False, "error": err[:600], "ms": round((time.monotonic() - t0) * 1000)})
            if fallback is None:
                fallback = Fallback(f"{device.name}載入模型失敗，已改用其他裝置", err[:600])
            continue
        attempts.append({"device": device.id, "ok": True, "ms": round((time.monotonic() - t0) * 1000)})
        return LoadResult(engine, requested, fallback, round((time.monotonic() - started) * 1000), attempts)
    raise RuntimeError("no device could load the model")  # 走不到：CPU 失敗已在迴圈內丟出


def nvidia_usage(device: Device) -> dict | None:
    """Nvidia 卡的使用率與顯示記憶體；拿不到回 None。"""
    if device.kind != "nvidia":
        return None
    target = device.id.split(":", 1)[1]
    out = sh(["nvidia-smi", f"--id={target}", "--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], timeout=5)
    if not out:
        return None
    try:
        util, used, total = (float(x) for x in out.splitlines()[0].split(","))
    except ValueError:
        return None
    return {"utilPercent": util, "memoryUsedMb": used, "memoryTotalMb": total}


def benchmark(engine: Engine, jpeg: bytes, seconds: float, warmup_s: float = 1.5, stop=lambda: False, progress=lambda f: None) -> dict | None:
    """同一張 JPEG 連續推論（含解碼與前後處理，和實際一張一張送的情況相同）。被取消回 None。"""
    end_warm = time.monotonic() + warmup_s
    n = 0
    while time.monotonic() < end_warm or n < 3:
        engine.infer_jpeg(jpeg)
        n += 1
        if stop():
            return None
    times: list[float] = []
    started = time.monotonic()
    last_report = started
    while time.monotonic() - started < seconds:
        t = time.perf_counter()
        engine.infer_jpeg(jpeg)
        times.append((time.perf_counter() - t) * 1000)
        now = time.monotonic()
        if now - last_report > 0.5:
            last_report = now
            progress(min(1.0, (now - started) / seconds))
            if stop():
                return None
    elapsed = time.monotonic() - started
    times.sort()
    return {
        "frames": len(times),
        "fps": round(len(times) / elapsed, 2),
        "msMean": round(statistics.mean(times), 2),
        "msP90": round(times[int(len(times) * 0.9)], 2),
    }
