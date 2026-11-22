"""狀態辨識 worker：`python3 detector/classify.py --socket <path> --backbone <onnx>`

和物件辨識的 detector 分開：有啟用的狀態感應器就要跑，不管物件辨識有沒有開；固定用 CPU（每張約 25 ms）。
連上主程序監聽的 Unix socket，訊息框架和 detector 相同：「1 位元組種類 + 4 位元組長度（big-endian）+ 內容」，
另加種類 3：「4 位元組 JSON 長度 + JSON + 二進位資料」。

- 主程序 → worker：
  種類 3 {"type":"classify","id":n,"sensor":…,"model":模型檔,"crop":[x1,y1,x2,y2],"mode":"force"|"changed"} + 一張 JPEG。
    changed：裁切區塊和這個感應器上次辨識時差不多就不推論，回 skipped。
  種類 1 背景工作（一次一個，依序執行，不擋辨識）：
    {"type":"train","job":n,"items":[{path,label}],"classes":[…],"out":模型檔}
    {"type":"collect","job":n,"ffmpeg":…,"points":[{path,offset,at}],"crop":[…],"outDir":…,"count":24}
    {"type":"import","job":n,"zip":…,"outDir":…}
- worker → 主程序：
  種類 1 {"type":"status","state":"loading"|"ready"|"error",…}、{"type":"heartbeat","busyMs":…,"job":bool}（每 2 秒）
  種類 3 {"type":"reading","id":n,"label":…,"index":i,"score":…,"probs":[…],"ms":…} + 裁切後的 JPEG
  種類 1 {"type":"reading","id":n,"skipped":"unchanged"} 或 {"type":"reading","id":n,"error":"…"}
  種類 1 {"type":"job-progress","job":n,"progress":0..1}、{"type":"job-result","job":n,"ok":true,"result":{…}} 或 {"ok":false,"error":"…"}
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import secrets
import struct
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import statecls as sc  # noqa: E402
from channel import KIND_JSON, Channel, connect, heartbeat  # noqa: E402
from fetch_model import manifest  # noqa: E402

KIND_BLOB = 3


class ClassifyChannel(Channel):
    def __init__(self, sock):
        super().__init__(sock)
        self.job = False

    def send_blob(self, msg: dict, data: bytes) -> None:
        head = json.dumps(msg, ensure_ascii=False).encode()
        self.send_frame(KIND_BLOB, struct.pack(">I", len(head)) + head + data)


class Classifier:
    def __init__(self, backbone: sc.Backbone, backbone_id: str):
        self.backbone = backbone
        self.backbone_id = backbone_id
        self.models: dict[str, tuple[float, sc.Model]] = {}
        self.reference: dict[str, object] = {}

    def model(self, path: str) -> sc.Model:
        mtime = os.path.getmtime(path)
        hit = self.models.get(path)
        if hit and hit[0] == mtime:
            return hit[1]
        m = sc.load_model(path, self.backbone_id)
        self.models[path] = (mtime, m)
        return m

    def handle(self, ch: ClassifyChannel, head: dict, jpeg: bytes) -> None:
        req_id = head.get("id")
        sensor = str(head.get("sensor"))
        try:
            crop = sc.crop_jpeg(jpeg, head["crop"])
            small = sc.small_gray(crop)
            if head.get("mode") == "changed" and not sc.changed(self.reference.get(sensor), small):  # type: ignore[arg-type]
                ch.send({"type": "reading", "id": req_id, "skipped": "unchanged"})
                return
            self.reference[sensor] = small
            model = self.model(head["model"])
            t0 = time.monotonic()
            feats = self.backbone.embed([crop])[0]
            index, score, probs = model.classify(feats)
            ms = round((time.monotonic() - t0) * 1000, 1)
            ch.send_blob({"type": "reading", "id": req_id, "label": model.classes[index], "index": index, "score": round(score, 4),
                          "probs": probs, "ms": ms}, sc.encode_jpeg(crop))
        except Exception as e:  # noqa: BLE001 — 一張壞畫面或壞模型只影響這次
            ch.send({"type": "reading", "id": req_id, "error": f"{type(e).__name__}: {e}"[:300], **coded(e)})


def coded(e: Exception) -> dict:
    """錯誤若是 CodedError，回傳要附在訊息裡的 code 與 params"""
    if not isinstance(e, sc.CodedError):
        return {}
    return {"code": e.code, **({"params": e.params} if e.params is not None else {})}


def new_name(ext: str) -> str:
    return secrets.token_hex(8) + ext


def run_ffmpeg(cmd: list[str]) -> bytes | None:
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout if r.returncode == 0 else None


def run_job(ch: ClassifyChannel, clf: Classifier, cache: sc.EmbeddingCache, cmd: dict) -> dict:
    job = cmd.get("job")
    last = [0.0]

    def progress(f: float) -> None:
        t = time.monotonic()
        if t - last[0] >= 0.25 or f >= 1:
            last[0] = t
            ch.send({"type": "job-progress", "job": job, "progress": round(min(1.0, f), 3)})

    kind = cmd.get("type")
    if kind == "train":
        info = {"id": clf.backbone_id, "name": manifest("backbone-model.json")["name"]}
        model = sc.train(clf.backbone, cache, cmd["items"], list(cmd["classes"]), info, progress)
        sc.write_json_atomic(cmd["out"], model)
        return {k: v for k, v in model.items() if k not in ("w", "b")}
    if kind == "import":
        os.makedirs(cmd["outDir"], exist_ok=True)
        return sc.import_zip(cmd["zip"], cmd["outDir"], new_name, progress)
    if kind == "collect":
        os.makedirs(cmd["outDir"], exist_ok=True)
        points = list(cmd["points"])
        frames = []
        with ThreadPoolExecutor(max_workers=4) as pool:
            for n, got in enumerate(pool.map(lambda p: sc.frames_from_recordings(cmd["ffmpeg"], [p], run_ffmpeg), points)):
                frames += got
                progress(0.8 * (n + 1) / max(1, len(points)))
        if not frames:
            return {"images": [], "tried": len(points)}
        crops = [sc.crop_image(im, cmd["crop"]) for _, im in frames]
        feats = clf.backbone.embed(crops)
        picked = sc.diverse(feats, int(cmd.get("count", 24)))
        images = []
        for i in picked:
            name = new_name(".jpg")
            with open(os.path.join(cmd["outDir"], name), "wb") as fh:
                fh.write(sc.encode_jpeg(crops[i]))
            images.append({"file": name, "at": frames[i][0].get("at")})
        progress(1)
        return {"images": images, "tried": len(points)}
    raise ValueError(f"unknown job {kind}")


def job_worker(ch: ClassifyChannel, clf: Classifier, jobs: "queue.Queue[dict]") -> None:
    cache = sc.EmbeddingCache()
    while True:
        cmd = jobs.get()
        ch.job = True
        try:
            result = run_job(ch, clf, cache, cmd)
            reply = {"type": "job-result", "job": cmd.get("job"), "ok": True, "result": result}
        except (ValueError, KeyError, OSError) as e:
            reply = {"type": "job-result", "job": cmd.get("job"), "ok": False, "error": str(e)[:400] if isinstance(e, ValueError) else f"{type(e).__name__}: {e}"[:400], **coded(e)}
        except Exception as e:  # noqa: BLE001 — 背景工作失敗不能讓辨識停下
            reply = {"type": "job-result", "job": cmd.get("job"), "ok": False, "error": f"{type(e).__name__}: {e}"[:400]}
        finally:
            ch.job = False
        try:
            ch.send(reply)
        except OSError:
            os._exit(0)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--socket", required=True)
    ap.add_argument("--backbone", required=True)
    ap.add_argument("--threads", type=int, default=2)
    args = ap.parse_args()

    ch = ClassifyChannel(connect(args.socket))
    threading.Thread(target=heartbeat, args=(ch, lambda: {"job": ch.job}), daemon=True).start()
    ch.send({"type": "status", "state": "loading"})
    info = manifest("backbone-model.json")
    try:
        import onnxruntime as ort

        t0 = time.monotonic()
        backbone = sc.Backbone(ort, args.backbone, args.threads)
        load_ms = round((time.monotonic() - t0) * 1000)
    except Exception as e:  # noqa: BLE001 — 骨幹模型缺檔或壞掉：回報後只送心跳，免得 supervisor 反覆重啟
        ch.send({"type": "status", "state": "error", "error": "無法載入狀態辨識用的影像特徵模型", "code": "states.backboneLoadFailed", "detail": f"{type(e).__name__}: {e}"[:600]})
        while ch.recv() is not None:
            pass
        return
    clf = Classifier(backbone, info["id"])
    ch.send({"type": "status", "state": "ready", "backbone": info["name"], "loadMs": load_ms, "threads": args.threads})

    jobs: "queue.Queue[dict]" = queue.Queue()
    threading.Thread(target=job_worker, args=(ch, clf, jobs), daemon=True).start()
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
            if cmd.get("type") in ("train", "collect", "import"):
                jobs.put(cmd)
            continue
        if kind != KIND_BLOB or len(body) < 4:
            continue
        (n,) = struct.unpack(">I", body[:4])
        try:
            head = json.loads(body[4:4 + n])
        except ValueError:
            continue
        ch.busy_since = time.monotonic()
        try:
            clf.handle(ch, head, body[4 + n:])
        finally:
            ch.busy_since = None


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, ConnectionResetError):
        pass
