<p align="center"><img src="web/assets/logo.png" width="96" alt=""></p>

# CookieNVR

家用 NVR，核心只做四件事：24 小時錄影、動作偵測、鏡頭控制（PTZ）、Home Assistant 連動。物件辨識（人、車、動物等）是選用功能，支援 CPU、Intel 內顯與 Nvidia 顯卡。

錄影直接複製攝影機的串流，不轉碼；偵測與辨識都不在錄影路徑上，任何一環出問題都不會讓錄影停下來。整套系統是一個 Docker 容器。

> **開發中，尚未發布第一個版本。** 目前只有 `edge` 映像（`main` 的最新建置）。Intel／Nvidia 的硬體路徑、HomeKit Secure Video、iPhone Safari 還沒有在真實環境完整驗證，設定與資料格式之後可能變動。

## 功能

- 24 小時錄影：60 秒一段的 fMP4，依天數與剩餘空間自動清理
- 回放：一條時間軸，事件標在上面，可拖曳、縮放、匯出片段
- 即時預覽：瀏覽器直接播放，多台同時看
- 動作偵測：畫面差分或相機內建偵測（ONVIF），可畫遮罩
- 物件辨識（選用）：只在看到人或車時才記錄事件
- 鏡頭控制：ONVIF PTZ 與預設點，Tapo 攝影機只要填 IP 與相機帳戶
- RTSP 轉發：其他軟體從 NVR 取得串流，不必再多連一次攝影機
- Home Assistant 整合：[CookieNVR-HA](https://github.com/gnehs/CookieNVR-HA)（自動發現、免複製 Token）
- Apple 家庭（HomeKit Secure Video，實驗性）

## 部署

```yaml
services:
  cookienvr:
    image: ghcr.io/gnehs/cookienvr:edge
    container_name: cookienvr
    restart: unless-stopped
    ports: ["8765:8765", "8554:8554"]
    environment:
      - PUID=99    # 以這個使用者執行（Unraid 慣例 99:100）；不設就以 root 執行
      - PGID=100
    volumes:
      - /path/to/appdata:/data            # 資料庫、縮圖、設定：建議放 SSD
      - /path/to/recordings:/recordings   # 錄影：量大，放一般硬碟即可
```

啟動後開 `http://<主機>:8765`，建立管理員帳號並新增第一台攝影機。

- `8765` 是網頁與 API，`8554` 是 RTSP 轉發；主機上的埠要和容器內相同。
- 沒掛 `/recordings` 時，錄影放在 `/data/recordings`。
- 設了 `PUID`／`PGID` 時，啟動時會把 `/data` 與錄影目錄交給這個使用者。第一次（或改了數字）會把整個目錄走一遍，錄影多時要等一下，之後就不再掃。`UMASK`（預設 `022`）決定新檔案的權限，`002` 讓同群組也能改。在設定頁把儲存路徑改到別的掛載點前，先在主機上把那個目錄交給同一個使用者。
- 要讓 Home Assistant 自動發現，或使用 Apple 家庭，改用 host 網路（`network_mode: host`，拿掉 `ports`）。

完整的設定（host 網路、Intel 內顯、Nvidia）見 [`docker-compose.example.yml`](docker-compose.example.yml)。

**Unraid**：把 [`unraid/cookienvr.xml`](unraid/cookienvr.xml) 存到 `/boot/config/plugins/dockerMan/templates-user/my-cookienvr.xml`，在 Docker 頁面按「Add Container」，從 Template 選單選 `cookienvr`。

### 映像

| 標籤 | 內容 | 平台 |
| --- | --- | --- |
| `edge` | CPU 推論；amd64 另含 Intel 內顯 | `linux/amd64`、`linux/arm64` |
| `edge-nvidia` | CPU 與 Nvidia（CUDA 12） | `linux/amd64` |

發布正式版本後會有 `latest`、`latest-nvidia` 與版本號標籤。

### 顯示卡（選用）

- **Intel 內顯**：加上 `devices: ["/dev/dri:/dev/dri"]`。設了 `PUID` 時，容器會自動加入裝置的群組。
- **Nvidia**：主機裝好 NVIDIA Container Toolkit，映像改用 `edge-nvidia`，並以 `runtime: nvidia` 或 `--gpus all` 啟動。

設好後可以在容器裡檢查每張卡實際能做什麼，輸出可以直接貼到 issue（`docker exec` 預設以 root 執行；設了 `PUID` 時加上 `-u 99:100` 會更接近 NVR 實際的權限）：

```bash
docker exec cookienvr detector-selftest
```

```bash
docker exec cookienvr video-selftest
```

## 開發

需要 [Bun](https://bun.sh)、ffmpeg 與 [MediaMTX](https://github.com/bluenviron/mediamtx)。

```bash
bun install
```

```bash
bun run dev:mock
```

`dev:mock` 用假資料啟動介面（不需要攝影機）。接真的攝影機時先 `bun run build`，再 `bun run dev`。檢查用 `bun run typecheck` 與 `bun test`。

設計與細節都在 [規格書](CookieNVR%20規格書.md)。

## 授權

[MIT](LICENSE)
