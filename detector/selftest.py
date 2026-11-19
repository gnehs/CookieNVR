"""物件辨識自我檢查：列出每個推論裝置、在每個裝置上用同一張內建測試圖推論與測速、比對結果。

容器內：`detector-selftest`；原始碼：`python3 detector/selftest.py [--model x.onnx] [--seconds 5] [--fps 2] [--expect intel,nvidia]`
--expect 可寫裝置類別（intel、nvidia）或裝置識別字（例如 nvidia:GPU-xxxx）。
最後印出一段摘要，可以直接貼給 AI 或開發者。結束碼：CPU 與所有偵測到（或 --expect 指定）的 GPU 都成功為 0。
"""

from __future__ import annotations

import argparse
import glob
import math
import os
import platform
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import engine as eng  # noqa: E402
import yolo  # noqa: E402
from fetch_model import manifest  # noqa: E402
from testimage import EXPECTED, test_image, test_jpeg  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
#: 換算「可同時處理幾台」時保留的餘裕：CPU 還要錄影、解碼，只算一半；GPU 的前後處理仍在 CPU，算八成。
#: 與 src/objects/capacity.ts 相同
HEADROOM = {"cpu": 0.5, "intel": 0.8, "nvidia": 0.8}
NOT_ON_DEVICE = "沒有實際執行這個模型"


def capacity(fps: float, kind: str, per_camera: float) -> int:
    """測得每秒 fps 張 → 同時有動作時，每台每秒辨識 per_camera 次，大約可以撐幾台。"""
    return max(0, math.floor(fps * HEADROOM.get(kind, 0.5) / per_camera))


def sh(cmd: list[str]) -> str | None:
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return (out.stdout or out.stderr).strip() or None


def intel_gpus() -> list[str]:
    """從 /sys 找 Intel 顯示卡：PCI id 與核心驅動（i915 / xe）。"""
    found = []
    for card in sorted(glob.glob("/sys/class/drm/card[0-9]")):
        try:
            vendor = open(f"{card}/device/vendor").read().strip()
            device = open(f"{card}/device/device").read().strip()
        except OSError:
            continue
        driver = os.path.basename(os.path.realpath(f"{card}/device/driver")) if os.path.exists(f"{card}/device/driver") else "?"
        if vendor == "0x8086":
            found.append(f"{os.path.basename(card)} 8086:{device[2:]} driver={driver}")
    return found


def hints(device: str, error: str, p: eng.Probe) -> list[str]:
    e = error.lower()
    if NOT_ON_DEVICE in error:
        return [f"{eng.RUNTIME_NAMES.get(device, device)} 看得到這個裝置，但沒有把模型放到上面執行（實際執行的比例見上一行），測到的速度其實是處理器的。",
                "常見原因：驅動版本不支援這顆顯示卡的運算、或模型用了這個裝置不支援的運算。CookieNVR 會自動改用其他裝置。"]
    if device == "intel":
        if not p.has_openvino:
            return ["這個映像不含 OpenVINO plugin：Intel 內顯只有 linux/amd64 的映像（latest 與 latest-nvidia）支援，arm64 映像沒有。"]
        if not p.dri_nodes:
            return ["容器裡沒有 /dev/dri：docker run 加 `--device /dev/dri:/dev/dri`（compose 用 `devices: [\"/dev/dri:/dev/dri\"]`）。",
                    "主機上先確認 `ls -l /dev/dri` 有 renderD128；Unraid 需要載入 i915（或新平台的 xe）驅動，例如安裝 Intel GPU TOP 外掛。"]
        if not p.dri_accessible:
            return ["容器內的使用者沒有 /dev/dri 的讀寫權限：加上 `--group-add $(stat -c %g /dev/dri/renderD128)`。"]
        return ["OpenVINO 看不到 GPU：多半是容器內的 Intel 運算驅動（Gen12 以後用 intel-opencl-icd，Gen8 到 11 用 intel-opencl-icd-legacy1）不支援這顆內顯，或主機核心驅動沒載入。",
                "請附上 `ls -l /dev/dri`、`uname -r`、本摘要裡的 Intel GPU PCI id 回報。",
                f"原始錯誤：{error[:300]}"]
    if device == "nvidia":
        if not p.has_cuda:
            return ["這個映像不含 CUDA 推論元件：請改用 `:latest-nvidia` 映像（只有 linux/amd64）。"]
        if not p.nvidia_nodes:
            return ["容器裡看不到 Nvidia 顯卡：主機要裝 NVIDIA Container Toolkit（Unraid：Nvidia Driver 外掛），",
                    "並以 `docker run --gpus all` 或 `--runtime=nvidia -e NVIDIA_VISIBLE_DEVICES=all` 啟動。"]
        if "insufficient" in e or "driver version" in e or "cudaerrorinsufficientdriver" in e:
            return ["主機的 Nvidia 驅動太舊：-nvidia 映像預設用 CUDA 12，需要驅動 525 以上（`nvidia-smi` 第一行可看版本）。"]
        if "libcudnn" in e or "libcublas" in e or "cannot open shared object" in e or "provider 沒有啟用" in error:
            return ["CUDA／cuDNN 函式庫沒有載入成功：多半是 GPU 太舊（CUDA 12 需要 Maxwell 以上）或驅動不相容。",
                    f"原始錯誤：{error[:300]}"]
        return [f"原始錯誤：{error[:300]}"]
    return [f"CPU 推論失敗，模型或 ONNX Runtime 安裝有問題：{error[:300]}"]


def same_results(a: list[yolo.Detection], b: list[yolo.Detection]) -> tuple[bool, str]:
    """以 CPU 為基準：同類別、框 IoU ≥ 0.8、信心值差 ≤ 0.05 算一致。"""
    def iou(x, y):
        w = max(0.0, min(x[2], y[2]) - max(x[0], y[0]))
        h = max(0.0, min(x[3], y[3]) - max(x[1], y[1]))
        inter = w * h
        union = (x[2] - x[0]) * (x[3] - x[1]) + (y[2] - y[0]) * (y[3] - y[1]) - inter
        return inter / union if union > 0 else 0.0

    strong_a = [d for d in a if d.score >= 0.4]
    worst = 0.0
    for d in strong_a:
        match = max((o for o in b if o.label == d.label), key=lambda o: iou(o.box, d.box), default=None)
        if match is None or iou(match.box, d.box) < 0.8:
            return False, f"{d.label} {d.score:.2f} 在另一個裝置沒有對應的框"
        worst = max(worst, abs(match.score - d.score))
    if worst > 0.05:
        return False, f"信心值最大差 {worst:.3f}"
    return True, f"信心值最大差 {worst:.3f}"


def fmt_dets(dets: list[yolo.Detection]) -> str:
    return ", ".join(f"{d.label} {d.score:.2f}" for d in dets if d.score >= 0.4) or "（沒有）"


def main() -> int:
    m = manifest()
    ap = argparse.ArgumentParser(description="CookieNVR detector self-test")
    ap.add_argument("--model", default=os.path.join(HERE, "models", m["file"]))
    ap.add_argument("--seconds", type=float, default=5.0, help="每個裝置測速幾秒（不含暖機）")
    ap.add_argument("--fps", type=float, default=2.0, help="換算時每台攝影機每秒辨識幾次")
    ap.add_argument("--expect", default="", help="逗號分隔，必須成功的 GPU：intel、nvidia 或裝置識別字")
    args = ap.parse_args()
    expect = {d for d in args.expect.split(",") if d}

    print("CookieNVR 物件辨識自我檢查\n")
    try:
        import onnxruntime as ort
    except ImportError as e:
        print(f"[失敗] 匯入 onnxruntime 失敗：{e}\n  這個 Python 沒有安裝推論相依；容器內請用 detector-selftest 指令。")
        return 1
    p = eng.probe(ort)
    smi = sh(["nvidia-smi", "--query-gpu=index,name,uuid,driver_version,compute_cap", "--format=csv,noheader"]) if p.nvidia_nodes or p.has_cuda else None
    igpu = intel_gpus()
    env_lines = [
        f"系統：{platform.system()} {platform.machine()}，核心 {platform.release()}，Python {platform.python_version()}，CPU 核心 {os.cpu_count()}（推論用 {eng.cpu_threads()} 執行緒）",
        f"onnxruntime {p.ort_version}；providers：{', '.join(p.providers)}",
        f"OpenVINO plugin：{'已安裝' if p.has_openvino else '未安裝'}{f'（{p.openvino_plugin_error}）' if p.openvino_plugin_error else ''}{'；列舉錯誤：' + p.enum_errors['intel'] if 'intel' in p.enum_errors else ''}{'；略過非 Intel 的 GPU：' + '、'.join(p.skipped_gpus) if p.skipped_gpus else ''}",
        f"/dev/dri：{', '.join(p.dri_nodes) or '沒有'}{'（可讀寫）' if p.dri_accessible else ('（沒有權限）' if p.dri_nodes else '')}；Intel GPU：{'; '.join(igpu) or '沒有看到'}",
        f"Nvidia：{', '.join(p.nvidia_nodes) or '沒有 /dev/nvidia*'}；nvidia-smi：{(smi or '無法執行').replace(chr(10), ' | ')}",
    ]
    print("環境")
    for line in env_lines:
        print(f"  {line}")
    print("\n偵測到的推論裝置（設定裡存的是識別字）")
    for d in p.devices:
        print(f"  - {d.id}：{d.name}")

    if not os.path.isfile(args.model):
        print(f"\n[失敗] 找不到模型 {args.model}\n  請先執行 python3 detector/fetch_model.py 下載內建模型。")
        return 1
    image, jpeg = test_image(), test_jpeg()
    print(f"\n模型：{os.path.basename(args.model)}；測試圖：內建街景（應辨識到 {'、'.join(EXPECTED)}）；每個裝置暖機後連續推論 {args.seconds:g} 秒\n")

    # 每個裝置一列；某一類完全沒有裝置時列出原因
    rows: list[tuple[str, str, eng.Device | None, eng.Fallback | None]] = []
    for kind in eng.KINDS:
        found = p.of_kind(kind)
        if found:
            rows.extend((d.id, d.name, d, None) for d in found)
        else:
            reason = eng.unavailable_reason(kind, p) or eng.Fallback(f"沒有偵測到{eng.KIND_NAMES[kind]}")
            rows.append((kind, eng.KIND_NAMES[kind], None, reason))
    for want in expect:
        if ":" in want and not p.find(want):
            rows.append((want, want, None, eng.Fallback("指定的裝置沒有偵測到")))

    results: dict[str, dict] = {}
    for key, name, device, missing in rows:
        kind = device.kind if device else key.split(":")[0]
        expected = key in expect or kind in expect
        if missing:
            status = "fail" if expected else "skip"
            results[key] = {"status": status, "kind": kind, "name": name, "reason": missing.reason, "error": missing.detail or missing.reason}
            print(f"[{name}] {'失敗' if expected else '略過'}：{missing.reason}")
            if expected:
                for h in hints(kind, missing.detail or missing.reason, p):
                    print(f"    → {h}")
            continue
        try:
            t0 = time.monotonic()
            engine = eng.build_engine(ort, args.model, device, p)
            load_ms = (time.monotonic() - t0) * 1000
            dets = engine.infer_image(image)
            bench = eng.benchmark(engine, jpeg, args.seconds)
        except yolo.ModelFormatError as e:
            print(f"[失敗] 模型格式不合：{e}")
            return 1
        except Exception as e:  # noqa: BLE001
            err = f"{type(e).__name__}: {e}"
            if isinstance(e, eng.NotOnDevice):
                err = f"{e}；實際執行：{eng.placement_text(e.placement)}"
            results[key] = {"status": "fail", "kind": kind, "name": name, "error": err}
            print(f"[{name}] 失敗：{err[:400]}")
            for h in hints(kind, err, p):
                print(f"    → {h}")
            continue
        found_labels = {d.label for d in dets if d.score >= 0.4}
        missing_labels = [label for label in EXPECTED if label not in found_labels]
        cams = capacity(bench["fps"], kind, args.fps)
        results[key] = {"status": "ok", "kind": kind, "name": name, "load_ms": load_ms, **bench, "dets": dets, "missing": missing_labels, "placement": engine.placement, "cams": cams}
        print(f"[{name}] 成功：載入 {load_ms:.0f} ms；每秒 {bench['fps']:.1f} 張（平均 {bench['msMean']:.1f} ms，九成在 {bench['msP90']:.1f} ms 內）")
        print(f"    實際執行：{eng.placement_text(engine.placement)}" + (f"（約 {1 - eng.device_share(engine.placement):.0%} 的時間在處理器上）" if kind != "cpu" and engine.placement else ""))
        print(f"    辨識：{fmt_dets(dets)}" + (f"；缺少 {', '.join(missing_labels)}（結果不合理）" if missing_labels else ""))
        print(f"    換算：同時有動作、每台每秒辨識 {args.fps:g} 次時，大約可以同時處理 {cams} 台攝影機")

    print()
    base = results.get("cpu", {})
    for key, r in results.items():
        if key != "cpu" and base.get("status") == "ok" and r.get("status") == "ok":
            ok, why = same_results(base["dets"], r["dets"])
            r["consistent"] = ok
            print(f"{r['name']} 與 CPU {'一致' if ok else '不一致'}（{why}）")

    auto = None
    try:
        loaded = eng.load(ort, args.model, "auto", p)
        auto = f"{loaded.engine.device.name}（{loaded.engine.device.id}）" + (f"；{loaded.fallback.reason}" if loaded.fallback else "")
        print(f"自動模式會使用：{auto}")
    except Exception as e:  # noqa: BLE001
        auto = f"載入失敗 {type(e).__name__}: {e}"
        print(f"自動模式：{auto}")

    failed = [k for k, r in results.items() if r["status"] == "fail" or r.get("missing") or r.get("consistent") is False]
    ok = not failed and results.get("cpu", {}).get("status") == "ok"
    print(f"\n換算的假設：物件辨識只在有動作時才跑，所有攝影機共用一個推論程序、一次一張；CPU 只算測得速度的 {HEADROOM['cpu']:.0%}（還要錄影與解碼），GPU 算 {HEADROOM['nvidia']:.0%}。")

    print("\n----- 摘要（可直接貼給 AI 或開發者）-----")
    print(f"CookieNVR detector selftest: {'PASS' if ok else 'FAIL'}")
    for line in env_lines:
        print(f"- {line}")
    print(f"- 模型 {os.path.basename(args.model)}，每個裝置測速 {args.seconds:g} 秒，換算以每台每秒 {args.fps:g} 次")
    for key, r in results.items():
        if r["status"] == "ok":
            extra = "" if "consistent" not in r else ("，與 CPU 一致" if r["consistent"] else "，與 CPU 不一致")
            print(f"- {r['name']} [{key}]: OK 載入 {r['load_ms']:.0f} ms，{r['fps']:.1f} 張/秒（平均 {r['msMean']:.1f} ms），約 {r['cams']} 台；實際執行 {eng.placement_text(r['placement'])}；{fmt_dets(r['dets'])}{extra}" + (f"；缺少 {r['missing']}" if r["missing"] else ""))
        elif r["status"] == "skip":
            print(f"- {r['name']}: 略過（{r['reason']}）")
        else:
            print(f"- {r['name']} [{key}]: 失敗 {r['error'][:300]}")
    print(f"- 自動模式：{auto}")
    print("-----")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
