"""下載內建模型並驗證 SHA-256：`python3 detector/fetch_model.py [目的目錄]`（預設 detector/models）。

builtin-model.json 是物件辨識的 YOLOX，backbone-model.json 是狀態辨識的影像特徵模型（DINOv2-small）。
兩者官方都沒有公布雜湊，清單裡的值是第一次下載後算出來釘住的（Hugging Face 的網址釘在某個 commit）；檔案被換掉就會建置失敗。
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


MANIFESTS = ("builtin-model.json", "backbone-model.json")


def manifest(name: str = "builtin-model.json") -> dict:
    with open(os.path.join(HERE, name), encoding="utf-8") as f:
        return json.load(f)


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    dest_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "models")
    os.makedirs(dest_dir, exist_ok=True)
    return max(fetch(manifest(name), dest_dir) for name in MANIFESTS)


def fetch(m: dict, dest_dir: str) -> int:
    dest = os.path.join(dest_dir, m["file"])
    if os.path.isfile(dest) and sha256(dest) == m["sha256"]:
        print(f"{dest} already present")
        return 0
    tmp = dest + ".part"
    with urllib.request.urlopen(m["url"], timeout=120) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    got = sha256(tmp)
    if got != m["sha256"]:
        os.remove(tmp)
        print(f"sha256 mismatch for {m['url']}: expected {m['sha256']}, got {got}", file=sys.stderr)
        return 1
    os.replace(tmp, dest)
    print(f"{dest} ({m['name']}, {m['license']}) ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
