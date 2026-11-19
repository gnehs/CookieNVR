"""內建測試圖：CC0 街景（停著一台汽車）貼上一個行人，自我檢查、測速與測試共用。"""

from __future__ import annotations

import io
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
#: 測試圖裡一定要辨識到的類別
EXPECTED = ("person", "car")


def test_image() -> Image.Image:
    street = Image.open(os.path.join(HERE, "assets", "street.jpg")).convert("RGB")
    person = Image.open(os.path.join(HERE, "assets", "person.jpg")).convert("RGB")
    street.paste(person, (300, 330))
    return street


def test_jpeg() -> bytes:
    """和 detect worker 送來的一樣：640 寬的 JPEG。"""
    buf = io.BytesIO()
    test_image().resize((640, 360)).save(buf, "JPEG", quality=80)
    return buf.getvalue()
