# 物件辨識 worker（detector）

主程序在「設定 → 一般 → 物件辨識」開啟時，才以 `$DETECTOR_PYTHON detector/main.py` 啟動這個 Python 程序，經 Unix socket 收畫面、回辨識結果。推論用 ONNX Runtime，裝置有 CPU、Intel 內顯（OpenVINO plugin EP）與 Nvidia（CUDA）。沒開物件辨識時不會啟動，不佔記憶體也不佔 CPU。

## 兩個映像

| 映像 | 平台 | 推論裝置 | 內容 |
| --- | --- | --- | --- |
| `latest` | linux/amd64、linux/arm64 | CPU；amd64 另有 Intel 內顯 | `onnxruntime`，amd64 加 `onnxruntime-ep-openvino` 與 Intel 運算驅動 |
| `latest-nvidia` | 只有 linux/amd64 | CPU、Nvidia | `onnxruntime-gpu` 1.26（CUDA 12、cuDNN 9.11） |

- Intel 內顯：同時裝 Intel compute-runtime 26.40（Gen12 以後：11 代 Core 起、N100、Arc）與 legacy 24.35（Gen8 到 Gen11：6 到 10 代 Core 的 UHD 630 等、Apollo Lake、Gemini Lake 如 J4125）。
- Nvidia：主機驅動 525 以上（Blackwell／RTX 50 要 570 以上）。cuDNN 釘在 9.11，是 CUDA 12 版最後一個還支援 Maxwell、Pascal、Volta（GTX 9xx、10xx、Quadro P400）的版本；舊卡實際能不能跑還沒有實機驗證。
- 用 CUDA 13（驅動 580 以上，只支援 Turing 以後）：建置時加 `--build-arg ONNXRUNTIME_GPU='onnxruntime-gpu[cuda,cudnn]==1.32.0'`。
- 沒有放 TensorRT：它要另外數 GB 的函式庫，第一次載入模型還要建引擎數分鐘；YOLOX-Tiny 這種小模型在 CUDA 上已經只要幾毫秒。

## 實機測試

以下在 amd64 主機上從 repo 根目錄執行。

### 建置

```sh
docker build -t cookienvr:test .                                   # 預設變體（CPU＋Intel 內顯）
docker build --build-arg VARIANT=nvidia -t cookienvr:test-nvidia .  # -nvidia 變體
```

在 arm64 建 `VARIANT=nvidia` 會直接失敗並說明只支援 amd64。

### 只跑自我檢查

自我檢查不需要啟動 NVR，也不碰 `/data`。

```sh
# Intel 內顯
docker run --rm --device /dev/dri:/dev/dri cookienvr:test detector-selftest --expect intel

# Nvidia（二選一）
docker run --rm --gpus all cookienvr:test-nvidia detector-selftest --expect nvidia
docker run --rm --runtime=nvidia -e NVIDIA_VISIBLE_DEVICES=all cookienvr:test-nvidia detector-selftest --expect nvidia
```

`--expect` 列出必須成功的 GPU：可以寫類別（`intel`、`nvidia`）或裝置識別字（例如 `nvidia:GPU-xxxx`），沒找到或失敗就回結束碼 1。不加 `--expect` 時找不到的 GPU 只會略過。其他參數：`--seconds 5`（每個裝置暖機後連續推論幾秒來測速）、`--fps 2`（換算「可同時處理幾台」時每台每秒辨識幾次）、`--model /data/models/x.onnx`（測自己的模型）。

自我檢查會先列出「偵測到的推論裝置」與每個裝置的識別字，然後在**每一個**裝置上推論與測速：兩張 Nvidia 卡就各測一次，摘要裡各一行。

### 多張 GPU

```sh
# 兩張 Nvidia：預設兩張都會測；只要其中一張，用 NVIDIA_VISIBLE_DEVICES 限制容器看得到的卡
docker run --rm --gpus all cookienvr:test-nvidia detector-selftest --expect nvidia
docker run --rm --gpus all cookienvr:test-nvidia sh -c 'nvidia-smi -L'        # 對照 UUID
docker run --rm --gpus all cookienvr:test-nvidia detector-selftest --expect nvidia:GPU-<uuid>

# 同時有 Intel 內顯與 Nvidia：用 -nvidia 映像只看得到 Nvidia；latest 映像只看得到 Intel 與 CPU
```

NVR 裡在「推論裝置」選單選特定的卡，設定存的是識別字（`nvidia:GPU-<uuid>`、`intel:GPU.0`），重開機或換插槽不會指到別張卡；那張卡不見時改用自動並在設定頁說明。設定頁的「測速」可以勾選多個裝置並排比較。

容器以 root 執行，所以不需要 render 群組。用 `--user` 改成一般使用者時，再加上 `--group-add "$(stat -c %g /dev/dri/renderD128)"`。

### 影像硬體解碼（`video-selftest`）

動作偵測的解碼（「設定 → 影像解碼」，`settings.devices.decode`）另有自己的檢查，不需要 Python，兩種映像都有：

```sh
# Intel（VAAPI）
docker run --rm --device /dev/dri:/dev/dri cookienvr:test video-selftest
# Nvidia（NVDEC／NVENC）；要有 video 能力，映像預設已帶
docker run --rm --gpus 'all,"capabilities=compute,utility,video"' cookienvr:test video-selftest
docker run --rm --runtime=nvidia -e NVIDIA_VISIBLE_DEVICES=all -e NVIDIA_DRIVER_CAPABILITIES=compute,utility,video cookienvr:test video-selftest
# 兩種都有
docker run --rm --device /dev/dri:/dev/dri --gpus 'all,"capabilities=compute,utility,video"' cookienvr:test video-selftest
# 正在跑的 NVR
docker exec cookienvr video-selftest
```

輸出依序是環境（ffmpeg 版本、`/dev/dri`、VA 驅動檔、Nvidia 環境變數）、找到的每張卡與識別字（和物件辨識同一套：`intel:GPU.0`、`nvidia:GPU-<uuid>`）、每張卡 × H.264／H.265 × 解碼／編碼的試跑結果與失敗原因，最後用 detect worker 同一條指令在每張卡上解一段 3 秒的影片。整段貼回來即可。

### 啟動 NVR

```sh
# Intel 內顯
docker run -d --name cookienvr -p 8765:8765 -p 8554:8554 -v /mnt/user/appdata/cookienvr:/data \
  --device /dev/dri:/dev/dri cookienvr:test

# Nvidia
docker run -d --name cookienvr -p 8765:8765 -p 8554:8554 -v /mnt/user/appdata/cookienvr:/data \
  --gpus all cookienvr:test-nvidia
```

compose 寫法見 repo 根目錄的 `docker-compose.example.yml`（`devices: ["/dev/dri:/dev/dri"]`，或 `runtime: nvidia` 加 `NVIDIA_VISIBLE_DEVICES=all`）。開好之後到「設定 → 一般 → 物件辨識」開啟、推論裝置選「自動」，狀態應顯示「使用中：<顯示卡型號>」；再按「測速」，看「這台機器大約可以同時處理 N 台攝影機」。已經在跑的容器也能直接檢查：`docker exec cookienvr detector-selftest --expect intel`。

### 預期輸出

最後一段摘要長這樣（數字因機器而異；CPU 那行的格式取自 Apple M 系列的實測，Intel 那行是示意，不是實測）：

```text
----- 摘要（可直接貼給 AI 或開發者）-----
CookieNVR detector selftest: PASS
- 系統：Linux x86_64，核心 6.6.68-Unraid，Python 3.13.5，CPU 核心 8（推論用 4 執行緒）
- onnxruntime 1.32.0；providers：AzureExecutionProvider, CPUExecutionProvider
- OpenVINO plugin：已安裝
- /dev/dri：/dev/dri/renderD128（可讀寫）；Intel GPU：card0 8086:3e92 driver=i915
- Nvidia：沒有 /dev/nvidia*；nvidia-smi：無法執行
- 模型 yolox_tiny.onnx，每個裝置測速 5 秒，換算以每台每秒 2 次
- Intel(R) Core(TM) i5-9400 CPU @ 2.90GHz [cpu]: OK 載入 70 ms，40.1 張/秒（平均 24.9 ms），約 10 台；car 0.85, person 0.83
- Intel(R) UHD Graphics 630 [intel:GPU.0]: OK 載入 9000 ms，90.0 張/秒（平均 11.1 ms），約 36 台；car 0.85, person 0.83，與 CPU 一致
- Nvidia 顯卡: 略過（這個映像沒有 Nvidia 推論元件，請改用 latest-nvidia 映像）
- 自動模式：Intel(R) UHD Graphics 630（intel:GPU.0）
-----
```

「約 N 台」的換算：測得的速度是最佳情況，CPU 只算一半（還要錄影與解碼）、GPU 算八成；物件辨識只在有動作時才跑，所以 N 是「同時有動作」的攝影機數。

GPU 第一次載入要編譯模型，可能要數十秒。NVR 把 OpenVINO 的編譯快取放在 `/data/detector-cache`，之後就快了；自我檢查沒有設 `OPENVINO_CACHE_DIR`，快取在容器的 `/tmp`，每個新容器都會重新編譯。

### 失敗時回報

請貼回：

1. `detector-selftest` 的完整輸出（不只摘要，上面的「→」提示也要）。
2. 主機上的 `uname -r`、`ls -l /dev/dri`；Nvidia 再加 `nvidia-smi` 的前 15 行。
3. 用的映像 tag 與啟動指令（docker run 或 compose 片段）。
4. NVR 已經在跑的話，「設定 → 狀態」的「複製診斷資訊」。

## 從原始碼執行

```sh
python3 -m venv .venv && .venv/bin/pip install -r detector/requirements.txt
.venv/bin/python detector/fetch_model.py          # 下載內建模型到 detector/models/ 並驗 SHA-256
.venv/bin/python -m unittest discover -s detector/tests
DETECTOR_PYTHON=.venv/bin/python scripts/detector-selftest
```

`scripts/detector-selftest` 依序找 `$DETECTOR_PYTHON`、`/opt/detector/bin/python`、`python3`。主程序也用 `DETECTOR_PYTHON`（預設 `python3`）。

## 模型

內建 [YOLOX-Tiny](https://github.com/Megvii-BaseDetection/YOLOX)（Apache-2.0），檔案來自官方 `0.1.1rc0` release 的 `yolox_tiny.onnx`。官方沒有公布雜湊，`builtin-model.json` 裡的 SHA-256 是我們第一次下載後釘住的；檔案被換掉時建置會失敗。

選 Tiny 是在速度與信心值之間取中間：CPU 實測（Apple M 系列、4 執行緒）每張約 12 ms；Nano 約 7 ms，但同一張圖的信心值明顯較低；S 約 34 ms。動作觸發時每台每秒預設只送 2 張，Tiny 在一般 NAS 的 CPU 上也跑得動多台。

內建模型是 COCO 80 類，**沒有包裹**。要辨識包裹需要自備含有這個類別的模型；類別名稱是 package 或 parcel 時介面會顯示「包裹」，也會出現在勾選清單與 HA 感應器。

自備模型放進 `/data/models/`（`.onnx`），在「設定 → 一般 → 物件辨識」選用。支援的輸出格式：

- YOLOX：`[1, N, 85]`（官方匯出，含 objectness）
- Ultralytics YOLOv8 / YOLO11：`[1, 84, N]`
- 內含 NMS 的 `[1, K, 6]`（x1, y1, x2, y2, score, class）

類別名稱讀模型 metadata 的 `names`，沒有就當成 COCO 80 類；名稱轉成小寫英文、數字與底線的鍵（`traffic light` → `traffic_light`），事件與設定都用這個鍵。Ultralytics 的模型是 AGPL-3.0，所以不內建，要用請自行匯出（`yolo export model=yolo11n.pt format=onnx`）。
