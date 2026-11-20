"""狀態辨識的核心：凍結的影像特徵模型（骨幹）把裁切畫面轉成向量，再用 numpy 訓練 softmax 回歸。

骨幹是 DINOv2-small（int8 ONNX，見 backbone-model.json）。特徵取最後一層 patch token 的平均（不用 CLS token：
在使用者的鐵捲門資料上交叉驗證，平均 patch 99%、CLS 98%），L2 正規化後乘上固定的倍率當作 logits 的輸入。
前處理：裁切區塊直接拉伸到 224×224（和 Frigate 一樣，不保留長寬比），RGB，ImageNet 的平均與標準差。

訓練時每張圖加 4 種變化（左右翻轉、變暗、變亮、灰階），灰階是為了夜間紅外線畫面；分類器用類別權重平衡張數。
"""

from __future__ import annotations

import io
import json
import os
import re
import time
import zipfile
from dataclasses import dataclass
from typing import Callable, Iterable

import numpy as np
from PIL import Image, ImageEnhance, ImageOps

SIZE = 224
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
FEATURE = "patch-mean"
SCALE = 10.0
L2 = 1e-4
EPOCHS = 300
LR = 0.5
MAX_FOLDS = 5
MODEL_VERSION = 1
BATCH = 8
# 裁切區塊縮成 32×32 灰階比較，平均差異超過這個值（0 到 255）算「有變化」
CHANGE_THRESHOLD = 6.0
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp")

Progress = Callable[[float], None]


class CodedError(ValueError):
    """帶訊息 code 的錯誤：str(e) 是中文後備，code 與 params 讓前端換成使用者的語言（同一套見 src/messages/states.ts）"""

    def __init__(self, text: str, code: str, params: dict | None = None):
        super().__init__(text)
        self.code = code
        self.params = params


class Backbone:
    def __init__(self, ort, path: str, threads: int = 2):
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])
        self.input = self.session.get_inputs()[0].name

    def embed(self, images: list[Image.Image]) -> np.ndarray:
        out = []
        for i in range(0, len(images), BATCH):
            x = np.stack([preprocess(im) for im in images[i:i + BATCH]])
            hidden = self.session.run(None, {self.input: x})[0]
            out.append(hidden[:, 1:].mean(axis=1))
        return np.concatenate(out).astype(np.float32) if out else np.zeros((0, 384), np.float32)


def preprocess(im: Image.Image) -> np.ndarray:
    x = np.asarray(im.convert("RGB").resize((SIZE, SIZE), Image.BILINEAR), np.float32) / 255
    return ((x - MEAN) / STD).transpose(2, 0, 1)


def crop_image(im: Image.Image, crop: list[float]) -> Image.Image:
    """crop 是 0 到 1 的 [x1, y1, x2, y2]；像素座標照 Frigate 用 int 截斷，至少留 1 像素"""
    w, h = im.size
    x1, y1 = int(crop[0] * w), int(crop[1] * h)
    x2, y2 = max(x1 + 1, int(crop[2] * w)), max(y1 + 1, int(crop[3] * h))
    return im.convert("RGB").crop((x1, y1, min(w, x2), min(h, y2)))


def crop_jpeg(jpeg: bytes, crop: list[float]) -> Image.Image:
    return crop_image(Image.open(io.BytesIO(jpeg)), crop)


def encode_jpeg(im: Image.Image, quality: int = 90) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def small_gray(im: Image.Image) -> np.ndarray:
    return np.asarray(im.convert("L").resize((32, 32), Image.BILINEAR), np.float32)


def changed(prev: np.ndarray | None, cur: np.ndarray) -> bool:
    return prev is None or float(np.abs(prev - cur).mean()) > CHANGE_THRESHOLD


def augment(im: Image.Image) -> list[Image.Image]:
    im = im.convert("RGB")
    return [
        im,
        ImageOps.mirror(im),
        ImageEnhance.Brightness(im).enhance(0.6),
        ImageEnhance.Brightness(im).enhance(1.4),
        im.convert("L").convert("RGB"),
    ]


def normalize(x: np.ndarray) -> np.ndarray:
    return x / np.maximum(np.linalg.norm(x, axis=-1, keepdims=True), 1e-12)


def fit_softmax(x: np.ndarray, y: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
    x = normalize(x)
    w = np.zeros((x.shape[1], k), np.float32)
    b = np.zeros(k, np.float32)
    counts = np.bincount(y, minlength=k).astype(np.float32)
    weight = (len(y) / (k * np.maximum(counts, 1)))[y]
    target = np.eye(k, dtype=np.float32)[y]
    for _ in range(EPOCHS):
        p = softmax(x @ w * SCALE + b)
        g = (p - target) * weight[:, None] / weight.sum()
        w -= LR * (SCALE * x.T @ g + L2 * w)
        b -= LR * g.sum(axis=0)
    return w, b


def softmax(z: np.ndarray) -> np.ndarray:
    z = z - z.max(axis=-1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=-1, keepdims=True)


def predict(w: np.ndarray, b: np.ndarray, feats: np.ndarray) -> np.ndarray:
    return softmax(normalize(feats) @ w * SCALE + b)


def stratified_folds(y: np.ndarray, n: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    folds = np.zeros(len(y), int)
    for c in np.unique(y):
        idx = rng.permutation(np.flatnonzero(y == c))
        folds[idx] = np.arange(len(idx)) % n
    return folds


def cross_validate(feats: np.ndarray, y: np.ndarray, classes: list[str]) -> dict | None:
    """feats 是 [張數, 變化數, 維度]，第 0 個變化是原圖；測試只用原圖。任何一類少於 2 張就不做"""
    k = len(classes)
    counts = np.bincount(y, minlength=k)
    n = int(min(MAX_FOLDS, counts.min()))
    if n < 2:
        return None
    folds = stratified_folds(y, n)
    pred = np.zeros(len(y), int)
    a = feats.shape[1]
    for i in range(n):
        tr, te = folds != i, folds == i
        w, b = fit_softmax(feats[tr].reshape(-1, feats.shape[2]), np.repeat(y[tr], a), k)
        pred[te] = predict(w, b, feats[te][:, 0]).argmax(axis=1)
    confusion = np.zeros((k, k), int)
    for t, p in zip(y, pred):
        confusion[t, p] += 1
    return {
        "folds": n,
        "accuracy": round(float((pred == y).mean()), 4),
        "perClass": [{"label": c, "correct": int(confusion[i, i]), "total": int(counts[i])} for i, c in enumerate(classes)],
        "confusion": confusion.tolist(),
    }


@dataclass
class Model:
    classes: list[str]
    w: np.ndarray
    b: np.ndarray

    def classify(self, feats: np.ndarray) -> tuple[int, float, list[float]]:
        p = predict(self.w, self.b, feats[None])[0]
        i = int(p.argmax())
        return i, float(p[i]), [round(float(v), 4) for v in p]


class EmbeddingCache:
    """訓練用：每張圖（含變化）的特徵，以路徑＋修改時間為鍵。圖片檔名不重複使用，所以不會拿到別張的特徵"""

    def __init__(self) -> None:
        self.items: dict[str, tuple[float, np.ndarray]] = {}

    def get(self, backbone: Backbone, path: str) -> np.ndarray:
        mtime = os.path.getmtime(path)
        hit = self.items.get(path)
        if hit and hit[0] == mtime:
            return hit[1]
        with Image.open(path) as im:
            feats = backbone.embed(augment(im))
        self.items[path] = (mtime, feats)
        return feats

    def forget_missing(self) -> None:
        for path in [p for p in self.items if not os.path.exists(p)]:
            del self.items[path]


def train(backbone: Backbone, cache: EmbeddingCache, items: list[dict], classes: list[str], backbone_info: dict,
          progress: Progress) -> dict:
    """items：[{path, label}]，label 必須在 classes 裡。回傳模型檔的內容（JSON 可序列化）"""
    t0 = time.monotonic()
    index = {c: i for i, c in enumerate(classes)}
    usable = [it for it in items if it["label"] in index]
    feats, labels, skipped = [], [], 0
    for n, it in enumerate(usable):
        try:
            feats.append(cache.get(backbone, it["path"]))
            labels.append(index[it["label"]])
        except (OSError, ValueError):
            skipped += 1
        progress(0.9 * (n + 1) / max(1, len(usable)))
    cache.forget_missing()
    y = np.array(labels, int)
    counts = np.bincount(y, minlength=len(classes)) if len(y) else np.zeros(len(classes), int)
    missing = [c for c, n in zip(classes, counts) if n == 0]
    if missing:
        raise CodedError("這些類別沒有可用的圖片：" + "、".join(missing), "states.classesWithoutImages", {"classes": missing})
    f = np.stack(feats)
    validation = cross_validate(f, y, classes)
    progress(0.97)
    w, b = fit_softmax(f.reshape(-1, f.shape[2]), np.repeat(y, f.shape[1]), len(classes))
    return {
        "version": MODEL_VERSION,
        "backbone": backbone_info,
        "preprocess": {"size": SIZE, "resize": "stretch-bilinear", "mean": MEAN.tolist(), "std": STD.tolist(), "feature": FEATURE, "scale": SCALE},
        "classes": classes,
        "w": w.round(6).tolist(),
        "b": b.round(6).tolist(),
        "trainedAt": int(time.time() * 1000),
        "trainMs": round((time.monotonic() - t0) * 1000),
        "counts": [{"label": c, "count": int(n)} for c, n in zip(classes, counts)],
        "skipped": skipped,
        "validation": validation,
    }


def load_model(path: str, backbone_id: str) -> Model:
    with open(path, encoding="utf-8") as fh:
        m = json.load(fh)
    if m.get("version") != MODEL_VERSION or m.get("backbone", {}).get("id") != backbone_id:
        raise CodedError("模型是用不同版本的骨幹訓練的，需要重新訓練", "states.modelBackboneChanged")
    return Model(list(m["classes"]), np.array(m["w"], np.float32), np.array(m["b"], np.float32))


def write_json_atomic(path: str, data: dict) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)
    os.replace(tmp, path)


def diverse(feats: np.ndarray, count: int) -> list[int]:
    """從特徵挑 count 張彼此差異最大的（最遠點貪婪法，餘弦距離）。Frigate 用 HSV 直方圖，這裡用骨幹特徵，
    同樣的光線下門開一半和全關也分得開"""
    if len(feats) <= count:
        return list(range(len(feats)))
    x = normalize(feats)
    chosen = [0]
    dist = 1 - x @ x[0]
    while len(chosen) < count:
        i = int(dist.argmax())
        chosen.append(i)
        dist = np.minimum(dist, 1 - x @ x[i])
    return chosen


# ─── 匯入 Frigate 的資料集 zip ─────────────────────────────────────────────────────

MAX_MEMBERS = 5000
MAX_MEMBER_BYTES = 20 * 1024 * 1024
MAX_TOTAL_BYTES = 1024 * 1024 * 1024
CLASS_RE = re.compile(r"^[^/\\.][^/\\]{0,31}$")
FRIGATE_TRAIN_RE = re.compile(r"-(?P<label>[^-]+)-(?P<score>[01](?:\.\d+)?)$")


def classify_member(name: str) -> tuple[str, str | None] | None:
    """zip 成員路徑 → ("dataset", 類別) 或 ("train", None)；不認得的路徑回 None。只看路徑字串，不信任其中的 .. 或絕對路徑"""
    if name.endswith("/") or "\\" in name or name.startswith("/"):
        return None
    parts = name.split("/")
    if any(p in ("", ".", "..") for p in parts) or not parts[-1].lower().endswith(IMAGE_EXTS):
        return None
    if parts[-1].startswith("."):
        return None
    if len(parts) >= 3 and parts[-3] == "dataset" and len(parts) <= 4:
        label = parts[-2]
        return ("dataset", label) if CLASS_RE.match(label) else None
    if len(parts) >= 2 and parts[-2] == "train" and len(parts) <= 3:
        return ("train", None)
    return None


def frigate_guess(filename: str) -> dict | None:
    m = FRIGATE_TRAIN_RE.search(os.path.splitext(filename)[0])
    if not m:
        return None
    score = float(m.group("score"))
    return {"label": m.group("label"), "score": score} if 0 <= score <= 1 else None


def import_zip(path: str, out_dir: str, new_name: Callable[[str], str], progress: Progress) -> dict:
    """解出可用的圖片到 out_dir（檔名由 new_name(副檔名) 產生，不沿用 zip 裡的路徑），回傳清單。
    每張都用 Pillow 驗證過；壞掉、太大、路徑不對的略過並計數"""
    labeled, pending, skipped = [], [], 0
    total = 0
    with zipfile.ZipFile(path) as zf:
        members = zf.infolist()
        if len(members) > MAX_MEMBERS:
            raise CodedError(f"zip 裡的檔案太多（{len(members)} 個，上限 {MAX_MEMBERS}）", "states.zipTooManyFiles", {"count": len(members), "max": MAX_MEMBERS})
        for n, info in enumerate(members):
            progress((n + 1) / max(1, len(members)))
            kind = classify_member(info.filename)
            if kind is None:
                continue
            if info.file_size > MAX_MEMBER_BYTES or total + info.file_size > MAX_TOTAL_BYTES:
                skipped += 1
                continue
            data = zf.read(info)
            total += len(data)
            try:
                with Image.open(io.BytesIO(data)) as im:
                    im.load()
                    fmt = (im.format or "").lower()
            except Exception:  # noqa: BLE001 — 壞圖只影響它自己
                skipped += 1
                continue
            ext = {"png": ".png", "jpeg": ".jpg", "webp": ".webp"}.get(fmt)
            if ext is None:
                skipped += 1
                continue
            name = new_name(ext)
            with open(os.path.join(out_dir, name), "wb") as fh:
                fh.write(data)
            base = info.filename.rsplit("/", 1)[-1]
            if kind[0] == "dataset":
                labeled.append({"file": name, "label": kind[1]})
            else:
                pending.append({"file": name, "guess": frigate_guess(base)})
    return {"labeled": labeled, "pending": pending, "skipped": skipped}


def frames_from_recordings(ffmpeg: str, points: Iterable[dict], run: Callable[[list[str]], bytes | None]) -> list[tuple[dict, Image.Image]]:
    """每個時間點用 ffmpeg 抽一張 640 寬的畫面（和 detect worker 的快照同尺寸）；抽不到的略過"""
    out = []
    for p in points:
        data = run([ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", f"{max(0.0, float(p['offset'])):.2f}", "-i", p["path"],
                    "-frames:v", "1", "-vf", "scale=640:-2", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "3", "-"])
        if not data:
            continue
        try:
            im = Image.open(io.BytesIO(data))
            im.load()
        except Exception:  # noqa: BLE001
            continue
        out.append((p, im))
    return out
