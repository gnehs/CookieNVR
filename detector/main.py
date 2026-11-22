"""detector worker：`python3 detector/main.py --socket <path> --device <auto|cpu|裝置識別字> --model <onnx>`
列出裝置：`python3 detector/main.py --list-devices`（印一行 JSON 後結束）

連上主程序監聽的 Unix socket，雙向都是「1 位元組種類 + 4 位元組長度（big-endian）+ 內容」：
- 主程序 → detector：
  種類 2：4 位元組請求編號 + 一張 JPEG。一次只送一張，等到結果才送下一張。
  種類 1：JSON 指令。{"type":"bench","devices":[識別字…],"seconds":10} 測速；{"type":"bench-cancel"} 取消。
- detector → 主程序（種類 1，JSON）：
  {"type":"status","state":"loading"|"ready"|"error", ...}  載入進度、實際裝置、退回原因、類別清單、模型格式錯誤；
    placement 是各 provider 實際佔的推論時間比例（{"CUDAExecutionProvider":0.99,"CPUExecutionProvider":0.01}），量不到為 null
  {"type":"heartbeat","busyMs":…,"bench":bool,"gpu":{…}|null}  每 2 秒；gpu 是 Nvidia 卡的使用率與顯示記憶體
  {"type":"result","id":n,"ms":推論毫秒,"detections":[{label,score,box}]} 或 {"type":"result","id":n,"error":"..."}
  {"type":"bench-progress","device":識別字,"fraction":0..1,"index":i,"total":n}
  {"type":"bench-result","cancelled":bool,"results":[{device,kind,name,ok,reason?,error?,placement?,loadMs,frames,fps,msMean,msP90}]}

模型格式不合時回報 error 後不結束，只送心跳，免得 supervisor 反覆重啟一個註定失敗的程序。
測速時不處理畫面（主程序在測速期間不送），心跳帶 bench: true，主程序不會把它當成卡死。
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import engine as eng  # noqa: E402
import yolo  # noqa: E402
from channel import KIND_JSON, Channel, connect, heartbeat  # noqa: E402
from testimage import test_jpeg  # noqa: E402

KIND_FRAME = 2
GPU_POLL_S = 10.0
MAX_BENCH_S = 60.0


class DetectorChannel(Channel):
    def __init__(self, sock):
        super().__init__(sock)
        self.bench = False
        self.gpu: dict | None = None


def gpu_poller(ch: DetectorChannel, device: eng.Device) -> None:
    while True:
        ch.gpu = eng.nvidia_usage(device)
        time.sleep(GPU_POLL_S)


def describe_model(path: str, layout: yolo.Layout) -> dict:
    return {
        "file": os.path.basename(path),
        "format": layout.kind,
        "input": [layout.width, layout.height],
        "classes": list(layout.names),
        "titles": list(layout.titles),
    }


def list_devices() -> None:
    import onnxruntime as ort

    p = eng.probe(ort)
    unavailable = {k: (r.to_json() if (r := eng.unavailable_reason(k, p)) else None) for k in ("intel", "nvidia")}
    print(json.dumps({"devices": [d.to_json() for d in p.devices], "unavailable": unavailable, "probe": p.to_json()}, ensure_ascii=False))


def run_bench(ch: DetectorChannel, ort, cmd: dict, current: eng.Engine, model_path: str, p: eng.Probe) -> None:
    ids = [d for d in cmd.get("devices", []) if isinstance(d, str)] or [current.device.id]
    seconds = min(MAX_BENCH_S, max(3.0, float(cmd.get("seconds", 10))))
    jpeg = test_jpeg()
    cancelled = False

    def stop() -> bool:
        nonlocal cancelled
        while not cancelled and ch.readable():
            msg = ch.recv()
            if msg is None:
                raise ConnectionResetError
            kind, body = msg
            if kind == KIND_JSON and json.loads(body).get("type") == "bench-cancel":
                cancelled = True
        return cancelled

    results = []
    ch.bench = True
    try:
        for i, device_id in enumerate(ids):
            device = p.find(device_id)
            base = {"device": device_id, "kind": device.kind if device else device_id.split(":")[0], "name": device.name if device else device_id}
            if device is None:
                results.append({**base, "ok": False, "error": "找不到這個裝置", "errorMsg": {"code": "detector.benchDeviceMissing"}})
                continue
            ch.send({"type": "bench-progress", "device": device_id, "fraction": 0, "index": i, "total": len(ids)})
            try:
                t0 = time.monotonic()
                engine = current if device.id == current.device.id else eng.build_engine(ort, model_path, device, p)
                load_ms = round((time.monotonic() - t0) * 1000)
                r = eng.benchmark(engine, jpeg, seconds, stop=stop,
                                  progress=lambda f, d=device_id, i=i: ch.send({"type": "bench-progress", "device": d, "fraction": f, "index": i, "total": len(ids)}))
            except (ConnectionResetError, BrokenPipeError):
                raise
            except eng.NotOnDevice as e:
                results.append({**base, "ok": False, "reason": f"{e}，這個裝置不適合用來辨識",
                                "reasonMsg": {"code": "detector.notOnDeviceBench", "params": e.params},
                                "error": f"NotOnDevice: 實際執行 {eng.placement_text(e.placement)}", "placement": e.placement})
                continue
            except Exception as e:  # noqa: BLE001 — 某個裝置不能用只影響它自己的結果
                results.append({**base, "ok": False, "error": f"{type(e).__name__}: {e}"[:400]})
                continue
            if r is None:
                break
            results.append({**base, "ok": True, "loadMs": load_ms, "placement": engine.placement, **r})
            if stop():
                break
    finally:
        ch.bench = False
    ch.send({"type": "bench-result", "cancelled": cancelled, "results": results})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--socket")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--model")
    ap.add_argument("--list-devices", action="store_true")
    args = ap.parse_args()
    if args.list_devices:
        list_devices()
        return
    if not args.socket or not args.model:
        ap.error("--socket and --model are required")

    ch = DetectorChannel(connect(args.socket))
    threading.Thread(target=heartbeat, args=(ch, lambda: {"bench": ch.bench, "gpu": ch.gpu}), daemon=True).start()
    ch.send({"type": "status", "state": "loading", "requested": args.device})

    import onnxruntime as ort

    p = eng.probe(ort)
    try:
        if not os.path.isfile(args.model):
            raise yolo.ModelFormatError(f"找不到模型檔 {os.path.basename(args.model)}", "detector.modelFileMissing", {"file": os.path.basename(args.model)})
        loaded = eng.load(ort, args.model, args.device, p)
    except yolo.ModelFormatError as e:
        err = {"type": "status", "state": "error", "error": str(e), "probe": p.to_json()}
        if e.code:
            err["code"] = e.code
            err["params"] = e.params
        ch.send(err)
        idle(ch)
        return
    except Exception as e:  # noqa: BLE001 — 檔案壞掉或 ONNX Runtime 讀不了，都是使用者能處理的模型問題
        ch.send({"type": "status", "state": "error", "error": "無法載入模型，檔案可能不是有效的 ONNX 模型", "code": "detector.modelNotOnnx", "detail": f"{type(e).__name__}: {e}"[:600], "probe": p.to_json()})
        idle(ch)
        return

    engine = loaded.engine
    if engine.device.kind == "nvidia":
        threading.Thread(target=gpu_poller, args=(ch, engine.device), daemon=True).start()
    ch.send({
        "type": "status",
        "state": "ready",
        "requested": loaded.requested,
        "device": engine.device.kind,
        "deviceId": engine.device.id,
        "deviceName": engine.device.name,
        "devices": [d.to_json() for d in p.devices],
        "fallback": loaded.fallback.to_json() if loaded.fallback else None,
        "model": describe_model(args.model, engine.layout),
        "loadMs": loaded.load_ms,
        "providers": engine.providers,
        "placement": engine.placement,
        "threads": eng.cpu_threads(),
        "attempts": loaded.attempts,
        "probe": p.to_json(),
    })

    while True:
        msg = ch.recv()
        if msg is None:
            return
        kind, body = msg
        if kind == KIND_JSON:
            try:
                cmd = json.loads(body)
            except ValueError:
                continue
            if cmd.get("type") == "bench":
                run_bench(ch, ort, cmd, engine, args.model, p)
            continue
        if kind != KIND_FRAME or len(body) < 4:
            continue
        (req_id,) = struct.unpack(">I", body[:4])
        ch.busy_since = time.monotonic()
        try:
            detections = engine.infer_jpeg(body[4:])
            ms = round((time.monotonic() - ch.busy_since) * 1000, 1)
            reply = {"type": "result", "id": req_id, "ms": ms, "detections": [d.to_json() for d in detections]}
        except Exception as e:  # noqa: BLE001 — 一張壞掉的畫面不該讓整個 worker 結束
            reply = {"type": "result", "id": req_id, "error": f"{type(e).__name__}: {e}"[:300]}
        finally:
            ch.busy_since = None
        ch.send(reply)


def idle(ch: Channel) -> None:
    while ch.recv() is not None:
        pass


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, ConnectionResetError):
        pass
