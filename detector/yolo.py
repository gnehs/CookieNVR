"""YOLO 的前處理與後處理，全部是純函式：不碰 ONNX Runtime，也不碰檔案。

支援三種輸出格式（以實際跑一次的輸出形狀判斷）：
- yolox：官方 ONNX，[1, N, 5 + C]，N 是 stride 8/16/32 的格點總數，框要用格點還原；輸入 BGR、不除 255、圖靠左上補 114。
- ultralytics：YOLOv8 / 11 的 ONNX，[1, 4 + C, N]，框是 cx cy w h、沒有 objectness；輸入 RGB、除 255、置中補 114。
- end2end：Ultralytics 匯出時內含 NMS 的格式（例如 YOLO26），[1, K, 6]，每列 x1 y1 x2 y2 score class；前處理同 ultralytics。
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass
from functools import cached_property

import numpy as np
from PIL import Image

from coco import COCO_NAMES

STRIDES = (8, 16, 32)
PAD_VALUE = 114
DEFAULT_SIZE = 640
NMS_IOU = 0.45
#: 送回主程序的最低信心值；各攝影機的門檻在主程序套用
MIN_SCORE = 0.25
MAX_DETECTIONS = 50


class ModelFormatError(Exception):
    """模型格式不合；訊息是給使用者看的中文。"""


def label_key(name: str, index: int) -> str:
    """類別名稱 → 事件與設定用的鍵：小寫英文、數字與底線（"traffic light" → traffic_light）。"""
    key = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:40]
    return key or f"class_{index}"


@dataclass(frozen=True)
class Layout:
    kind: str  # "yolox" | "ultralytics" | "end2end"
    width: int
    height: int
    #: 模型原本的類別名稱
    titles: tuple[str, ...]

    @cached_property
    def names(self) -> tuple[str, ...]:
        """類別的鍵，見 label_key；重複的鍵加上編號"""
        seen: dict[str, int] = {}
        out = []
        for i, t in enumerate(self.titles):
            k = label_key(t, i)
            seen[k] = seen.get(k, 0) + 1
            out.append(k if seen[k] == 1 else f"{k}_{seen[k]}")
        return tuple(out)

    @property
    def rgb(self) -> bool:
        return self.kind != "yolox"

    @property
    def centered(self) -> bool:
        return self.kind != "yolox"

    @property
    def scale(self) -> float:
        return 1.0 if self.kind == "yolox" else 1.0 / 255.0


@dataclass(frozen=True)
class Detection:
    label: str
    score: float
    #: 0 到 1 的比例座標 (x1, y1, x2, y2)，相對於原始畫面
    box: tuple[float, float, float, float]

    def to_json(self) -> dict:
        return {"label": self.label, "score": round(self.score, 4), "box": [round(v, 4) for v in self.box]}


def input_size(shape: list) -> tuple[int, int]:
    """模型輸入 [1, 3, H, W]；動態維度用 640。回傳 (寬, 高)。"""
    if len(shape) != 4 or (isinstance(shape[1], int) and shape[1] != 3):
        raise ModelFormatError(f"模型的輸入應該是 [1, 3, 高, 寬] 的影像，這個模型是 {list(shape)}")
    h = shape[2] if isinstance(shape[2], int) and shape[2] > 0 else DEFAULT_SIZE
    w = shape[3] if isinstance(shape[3], int) and shape[3] > 0 else DEFAULT_SIZE
    if h % 32 or w % 32:
        raise ModelFormatError(f"模型的輸入尺寸 {w}×{h} 不是 32 的倍數，看起來不是 YOLO 模型")
    return w, h


def grid_count(width: int, height: int) -> int:
    return sum((height // s) * (width // s) for s in STRIDES)


def parse_names(metadata: dict[str, str]) -> tuple[str, ...] | None:
    """Ultralytics 匯出的模型在 metadata 的 names 放 "{0: 'person', ...}"。"""
    raw = metadata.get("names")
    if not raw:
        return None
    try:
        value = ast.literal_eval(raw)
    except (ValueError, SyntaxError):
        return None
    if isinstance(value, dict) and all(isinstance(k, int) for k in value):
        return tuple(str(value[k]) for k in sorted(value))
    if isinstance(value, (list, tuple)):
        return tuple(str(v) for v in value)
    return None


def _class_names(count: int, metadata: dict[str, str]) -> tuple[str, ...]:
    names = parse_names(metadata)
    if names is not None and len(names) == count:
        return names
    if count == len(COCO_NAMES):
        return COCO_NAMES
    raise ModelFormatError(f"模型有 {count} 個類別，但沒有附類別名稱；目前只支援 COCO 80 類或在 metadata 帶 names 的模型")


def detect_layout(input_shape: list, output_shape: tuple[int, ...], metadata: dict[str, str] | None = None) -> Layout:
    """以模型輸入形狀與實際輸出形狀判斷格式。"""
    metadata = metadata or {}
    width, height = input_size(input_shape)
    expected = grid_count(width, height)
    shape = tuple(output_shape)
    hint = "支援 YOLOX（[1, N, 85]）、Ultralytics YOLOv8 / 11（[1, 84, N]）與內含 NMS 的 [1, K, 6]"
    if len(shape) != 3 or shape[0] != 1:
        raise ModelFormatError(f"看不懂模型的輸出形狀 {list(shape)}；{hint}")
    _, a, b = shape
    if a == expected and b > 5:
        return Layout("yolox", width, height, _class_names(b - 5, metadata))
    if b == expected and a > 4:
        return Layout("ultralytics", width, height, _class_names(a - 4, metadata))
    if b == 6 and a <= 1000:
        names = parse_names(metadata) or COCO_NAMES
        return Layout("end2end", width, height, names)
    raise ModelFormatError(f"看不懂模型的輸出形狀 {list(shape)}（輸入 {width}×{height}，格點應有 {expected} 個）；{hint}")


@dataclass(frozen=True)
class Letterbox:
    ratio: float
    pad_x: float
    pad_y: float
    src_w: int
    src_h: int


def preprocess(image: Image.Image, layout: Layout) -> tuple[np.ndarray, Letterbox]:
    """縮放到模型輸入、補邊，回傳 [1, 3, H, W] float32 與還原座標要用的參數。"""
    src_w, src_h = image.size
    ratio = min(layout.width / src_w, layout.height / src_h)
    new_w, new_h = max(1, round(src_w * ratio)), max(1, round(src_h * ratio))
    resized = image.convert("RGB").resize((new_w, new_h), Image.Resampling.BILINEAR)
    canvas = np.full((layout.height, layout.width, 3), PAD_VALUE, dtype=np.uint8)
    pad_x = (layout.width - new_w) / 2 if layout.centered else 0.0
    pad_y = (layout.height - new_h) / 2 if layout.centered else 0.0
    x0, y0 = int(round(pad_x - 0.1)), int(round(pad_y - 0.1))
    canvas[y0 : y0 + new_h, x0 : x0 + new_w] = np.asarray(resized)
    if not layout.rgb:
        canvas = canvas[:, :, ::-1]
    tensor = canvas.transpose(2, 0, 1)[None].astype(np.float32)
    if layout.scale != 1.0:
        tensor *= layout.scale
    return np.ascontiguousarray(tensor), Letterbox(ratio, float(x0), float(y0), src_w, src_h)


def _yolox_grids(width: int, height: int) -> tuple[np.ndarray, np.ndarray]:
    grids, strides = [], []
    for s in STRIDES:
        hs, ws = height // s, width // s
        yv, xv = np.meshgrid(np.arange(hs), np.arange(ws), indexing="ij")
        grids.append(np.stack((xv, yv), 2).reshape(-1, 2))
        strides.append(np.full((hs * ws, 1), s))
    return np.concatenate(grids).astype(np.float32), np.concatenate(strides).astype(np.float32)


def decode(output: np.ndarray, layout: Layout) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """原始輸出 → (框 xyxy［模型輸入的像素座標］, 信心值, 類別編號)，尚未做 NMS。"""
    if layout.kind == "yolox":
        pred = output[0].astype(np.float32)
        grids, strides = _yolox_grids(layout.width, layout.height)
        xy = (pred[:, :2] + grids) * strides
        wh = np.exp(np.clip(pred[:, 2:4], -20, 20)) * strides
        cls = pred[:, 5:] * pred[:, 4:5]
    elif layout.kind == "ultralytics":
        pred = output[0].T.astype(np.float32)
        xy, wh, cls = pred[:, :2], pred[:, 2:4], pred[:, 4:]
    else:
        pred = output[0].astype(np.float32)
        return pred[:, :4], pred[:, 4], pred[:, 5].astype(np.int64)
    class_ids = cls.argmax(1)
    scores = cls[np.arange(len(cls)), class_ids]
    boxes = np.concatenate((xy - wh / 2, xy + wh / 2), 1)
    return boxes, scores, class_ids


def nms(boxes: np.ndarray, scores: np.ndarray, iou: float = NMS_IOU) -> list[int]:
    """貪婪 NMS，回傳保留的索引（依信心值由高到低）。"""
    x1, y1, x2, y2 = boxes.T
    areas = np.maximum(0, x2 - x1) * np.maximum(0, y2 - y1)
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size:
        i = int(order[0])
        keep.append(i)
        rest = order[1:]
        w = np.maximum(0, np.minimum(x2[i], x2[rest]) - np.maximum(x1[i], x1[rest]))
        h = np.maximum(0, np.minimum(y2[i], y2[rest]) - np.maximum(y1[i], y1[rest]))
        inter = w * h
        overlap = inter / np.maximum(areas[i] + areas[rest] - inter, 1e-9)
        order = rest[overlap <= iou]
    return keep


def postprocess(output: np.ndarray, layout: Layout, box: Letterbox, min_score: float = MIN_SCORE) -> list[Detection]:
    boxes, scores, class_ids = decode(output, layout)
    mask = scores >= min_score
    boxes, scores, class_ids = boxes[mask], scores[mask], class_ids[mask]
    if not len(scores):
        return []
    # 不同類別互不壓制：把每一類平移到互不重疊的位置再做一次 NMS
    offset = class_ids[:, None].astype(np.float32) * (max(layout.width, layout.height) + 1)
    keep = nms(boxes + offset, scores)[:MAX_DETECTIONS]
    out: list[Detection] = []
    for i in keep:
        x1, y1, x2, y2 = boxes[i]
        restored = (
            ((x1 - box.pad_x) / box.ratio) / box.src_w,
            ((y1 - box.pad_y) / box.ratio) / box.src_h,
            ((x2 - box.pad_x) / box.ratio) / box.src_w,
            ((y2 - box.pad_y) / box.ratio) / box.src_h,
        )
        clipped = tuple(float(min(1.0, max(0.0, v))) for v in restored)
        cid = int(class_ids[i])
        names = layout.names
        label = names[cid] if 0 <= cid < len(names) else f"class_{cid}"
        out.append(Detection(label, float(scores[i]), clipped))  # type: ignore[arg-type]
    return out
