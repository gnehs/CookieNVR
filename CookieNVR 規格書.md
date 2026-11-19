# CookieNVR 規格書

Nov 17, 2026 · @Liao Chun Sheng

## 概述與目標

CookieNVR 是一套家用 NVR，核心只做四件事：24 小時錄影、動作偵測、Tapo 鏡頭控制、Home Assistant 連動。YOLO 物件辨識是選用功能，支援 Intel 內顯與 Nvidia 顯卡。它刻意不做影像轉碼，物件辨識也不放在錄影路徑上，用更少的元件換取穩定性。

### 為什麼不用 Frigate

Frigate 把物件偵測模型、go2rtc、轉碼、錄影、UI 全部綁在一起，任何一環出問題都可能拖垮錄影。CookieNVR 的取捨：

| 面向 | Frigate | CookieNVR |
| --- | --- | --- |
| 偵測 | 以 AI 物件偵測為核心（需 Coral / GPU） | 以畫面差分或相機內建偵測（ONVIF）為核心；YOLO 選用，只在有動作時才跑，當掉就退回純動作偵測 |
| 錄影 | 經 go2rtc 轉發 | 經內建 MediaMTX 轉發，ffmpeg `-c copy` 切片，影像不轉碼；可單台改為直連相機 |
| 設定 | YAML 設定檔 | 全部在網頁介面調整，無設定檔 |
| 部署 | 單一容器，依賴多 | 單一容器；外部元件只有 ffmpeg、MediaMTX（轉發）與 HAP-NodeJS（HKSV 用） |
| 帳號 | 基本驗證 | 多使用者、角色、API Token |

### 設計原則

1. **錄影優先**：錄影 process 與偵測、預覽各自獨立，偵測或預覽當掉不影響錄影。錄影預設經轉發層讀取，轉發層重啟時所有攝影機會短暫缺片；可單台改為直連相機避開（見「RTSP 轉發」）。
2. **影像不轉碼**：影像一律原樣寫入（音訊視需要轉 AAC），CPU 只花在低解析度的偵測畫面。
3. **會自己恢復**：每個 ffmpeg 都有 watchdog，斷線、卡住、異常退出都自動重啟。
4. **零設定檔**：容器只需掛一個 `/data`，其餘都在前端完成。
5. **最少依賴**：後端只用 Bun 內建功能（SQLite、HTTP、密碼雜湊）、ffmpeg 與 MediaMTX（RTSP 轉發）；唯一的 npm 套件是 HKSV 用的 HAP-NodeJS，關閉 HKSV 時不會載入。物件辨識是獨立的 Python worker（ONNX Runtime），沒開就不啟動。

### 非目標（第一版不做）

- 人臉辨識、車牌辨識、物件追蹤
- 轉碼、多畫質轉發、WebRTC
- 雲端備份、遠端存取（交給 WireGuard / Cloudflare Tunnel）
- 手機 App（網頁做 RWD 即可）
- 硬體轉碼：所有 ffmpeg 工作都是直接複製影像，只有 detect worker 解碼（可選硬體解碼，見「影像硬體解碼」）
- 多鏡頭同步回放、逐幀播放

## 部署：單一 Docker 容器

整套系統是一個容器、一個 port、一個 volume，在 Unraid 用 Docker Compose 或 Docker 頁面都能直接跑。

- **映像內容**：`oven/bun`（Debian slim）＋ ffmpeg / ffprobe ＋ MediaMTX ＋ 物件辨識用的 Python 與 ONNX Runtime ＋ CookieNVR 原始碼與建置好的網頁介面（`dist/web`）。Dockerfile 多一個建置階段跑 `vite build`，前端套件不進最終映像。
- **映像版本**：`latest` 含 CPU 推論，amd64 另含 Intel 內顯（OpenVINO plugin EP 與 Intel OpenCL 驅動，26.40 與 24.35 legacy 並裝）；`latest-nvidia` 改含 Nvidia（CUDA 12、cuDNN 9.11，主機驅動 525 以上）。不用物件辨識時兩者沒有差別，detector 不啟動，只是映像比較大（壓縮後 arm64 約 301 MB、amd64 約 680 MB；M3 時約 217 MB；-nvidia 估計約 2 GB）。
- **平台**：`latest` 支援 `linux/amd64` 與 `linux/arm64`；`latest-nvidia` 只有 `linux/amd64`。
- **GPU（選用，物件辨識與影像硬體解碼用）**：Intel 內顯掛入 `/dev/dri`；Nvidia 需主機裝好 NVIDIA Container Toolkit（Unraid 用 Nvidia Driver 外掛），並以 `--gpus all` 或 `runtime: nvidia` 啟動，硬體解碼另需 `NVIDIA_DRIVER_CAPABILITIES` 含 `video`（映像預設 `compute,utility,video`）。amd64 映像都含 Intel 的 VA 驅動（`intel-media-va-driver`、`i965-va-driver`）。沒有 GPU 時用 CPU。
- **網路**：容器需能連到攝影機的 554（RTSP）與 2020（Tapo ONVIF）。bridge 模式即可運作；想讓 Home Assistant 自動發現、或啟用 HKSV 時要用 host 網路，或 Unraid 的 br0 給獨立 IP，因為兩者都靠 mDNS。

| 項目 | 值 | 說明 |
| --- | --- | --- |
| Port | `8765` | 網頁、API、瀏覽器串流共用 |
| Port | `8554` | RTSP 轉發，給外部裝置與 HA 接 |
| Port | `51826` 起 | HKSV：每台攝影機一個 HomeKit 配件 port（起始值可經 API 改），需 host 網路或 br0 |
| Volume | `/data` | 資料庫、縮圖、設定。量小但讀寫頻繁，建議放 SSD |
| Volume | `/recordings` | 錄影。量大，放一般硬碟即可。掛了就自動使用；沒掛時錄影放在 `/data/recordings` |
| `RECORDINGS_DIR` | 選用 | 明確指定錄影的預設位置，優先於上面的自動判斷 |
| `PORT` | 選用 | 覆寫網頁 port |
| `DISCOVERY` | 選用 | `false` 時不在區域網路上廣播（預設開啟） |
| `PUBLIC_PORT` | 選用 | mDNS 廣播的網頁埠，預設同 `PORT`；對外看到的埠不同時才需要 |

時區不需要設定：顯示一律用瀏覽器的時區，錄影檔名與資料庫一律存 UTC。

RTSP 轉發的主機埠要和容器內相同（預設 `8554:8554`）：App 顯示給使用者的 RTSP 網址用的是容器內的埠。

容器驗證：`bun scripts/docker-e2e.ts` 建置映像，起一個假相機容器與一個 NVR 容器，經 HTTP API 走完初始設定、測試連線、錄影（經轉發與直連各一台）、下載片段、快照、RTSP 帳密、強制結束 ffmpeg 與 MediaMTX、`docker stop`、同一個 volume 重啟與 SIGKILL 後重啟，並以 `TZ=Asia/Taipei` 確認片段檔名仍是 UTC；最後在容器內跑 `detector-selftest`，開啟 CPU 物件辨識後確認街景假相機（`street;person=…` 場景）的事件標上 `person`。失敗時印出是哪一步，結束時清掉自己建立的容器、volume 與 network。CI 在 PR 與 main 上跑它（約 8 分鐘）。映像體積靠移除 ffmpeg 連帶裝進來、但錄影用不到的 Mesa 與 LLVM 瘦身（約 250 MB）。

環境變數只管「容器怎麼跑」，不含任何攝影機或功能設定。第一次開啟網頁會進入初始設定，建立管理員帳號。

```yaml
services:
  cookienvr:
    image: ghcr.io/gnehs/cookienvr:latest
    restart: unless-stopped
    ports: ["8765:8765", "8554:8554"]
    # 讓 HA 自動發現或啟用 HKSV 時改用 host 網路（拿掉 ports）：
    # network_mode: host
    volumes:
      - /mnt/user/appdata/cookienvr:/data
      - /mnt/user/recordings:/recordings
    # 物件辨識用 Intel 內顯：
    # devices: ["/dev/dri:/dev/dri"]
    # 物件辨識用 Nvidia：映像改用 :latest-nvidia，並加上
    # runtime: nvidia
    # environment: ["NVIDIA_VISIBLE_DEVICES=all"]
```

完整註解版（含 render 群組與 `--gpus all` 的 compose 寫法）在 repo 的 `docker-compose.example.yml`。

## 系統架構

一個容器裡有一個輕量主程序和多個獨立 worker。相機只接轉發層，其餘 worker 都從轉發層讀影像；主程序不碰影像資料，只負責監管、API、資料庫與 ONVIF。

- **相機 → 轉發層**：restream worker（MediaMTX）對每台相機的 main、sub 各開一條 RTSP 連線。
- **轉發層 → worker**：record（切片錄影）、detect（差分與快照）、live（瀏覽器用 fMP4）、homekit（HKSV）都從轉發層讀。
- **detect → 主程序 → detector**：開啟物件辨識時，各台 detect worker 依辨識頻率輸出 JPEG，主程序在這台有動作時經 Unix socket 轉給共用的 detector worker 做 YOLO 推論。
- **轉發層 → 外部**：HA、VLC 等 RTSP 用戶端從 `:8554` 讀。
- **主程序**：監管所有 worker，提供 `:8765` 的網頁、API 與瀏覽器串流，並負責 SQLite 與 ONVIF。

匯出與家庭 App 串流用的臨時 ffmpeg 也是 worker，完整清單見「穩定性設計」。

## 攝影機接入：Tapo 與通用 RTSP

第一版支援兩種攝影機類型。Tapo 只要填 IP 和相機帳號，其餘自動推導；通用 RTSP 要自己填串流網址。

| 欄位 | Tapo | 通用 RTSP |
| --- | --- | --- |
| 主碼流 | 自動：`rtsp://帳號:密碼@IP:554/stream1` | 必填 |
| 子碼流 | 自動：`.../stream2` | 選填；留空就用主碼流縮小偵測 |
| ONVIF | 自動：port 2020，同一組帳密 | 選填（主機、port、帳密），填了就能用 PTZ 與相機事件 |
| 音訊 | 預設錄音；PCM A-law 轉 AAC 64 kbps | 依串流而定，可關閉 |
| 傳輸 | TCP | TCP / UDP 可選 |

### 新增攝影機流程

1. 在「設定 → 攝影機」選類型，填名稱與連線資訊。
2. 按「測試並儲存」：後端用 ffprobe 讀兩個碼流，回傳編碼、解析度、幀率、音訊格式，並拍一張快照；Tapo 另外測 ONVIF 是否可用、有沒有 PTZ。
3. 測試成功就直接儲存，畫面只顯示快照、「已開始錄影」與「完成」，碼流摘要收在「詳細資訊」，並立刻開始錄影；失敗則停在表單，錯誤用一般人看得懂的話掛在最相關的欄位旁（IP、帳密或網址），英文原文只在「複製錯誤內容」裡。只改名稱或開關、沒有動到連線欄位時不重測。
4. ONVIF、傳輸方式、錄影直連與「給其他 App 的串流網址」收在預設收合的「進階」。串流網址欄位未聚焦時遮住網址中的密碼。第一次建立管理員後進到獨立置中的新增攝影機畫面（`/welcome`），可以「稍後再說」。
5. 刪除攝影機預設只移除設定：已錄的影片留在硬碟上，介面上無法再回放，但仍照保留天數與最低剩餘空間規則清除，在那之前繼續佔用空間（「錄影與儲存」裡顯示為「已刪除的攝影機」，旁邊有「清除」可以一次刪掉）。刪除對話框可勾選「同時刪除這台的錄影」（`DELETE /api/cameras/:id?recordings=delete`）：後端等這台的錄影程序確定停止後，在索引掃描暫停的狀態下刪除該台的片段檔案與資料庫紀錄、事件與縮圖，所以不會被索引或啟動對帳加回來；清除在回應之後於背景進行，失敗寫入日誌。

### Tapo 前置準備（寫進介面提示）

- 在 Tapo App 的「進階設定 → 相機帳戶」建立帳密，這組不是 TP-Link 雲端帳號。
- Tapo 限制同時 RTSP 連線數，CookieNVR 預設只佔兩條（主、子各一），HA、瀏覽器、HKSV 與外部裝置都從 NVR 的 RTSP 轉發接。實測一台 Tapo（2560×1440 主碼流）的上限是按碼流分開算的，主、子碼流各有自己的名額，超過的連線會被相機直接拒絕。測試當下另有一套監視器軟體連著同一台相機，每個碼流只剩一個名額，所以每個碼流的實際上限還不確定（推測是兩條），要在沒有其他軟體連線時重測。
- 建議在路由器把相機 IP 固定。

## RTSP 轉發

CookieNVR 對每台攝影機的每個碼流只開一條連線，再由內建的轉發層分發給所有使用者，相機不會因為接的裝置變多而過載。

### 轉發層：內建 MediaMTX

- 容器內附帶 MediaMTX（單一 Go 執行檔），由 CookieNVR 啟動、監控、重啟，當成一個 worker。
- 不產生使用者可見的設定檔：啟動時給最小設定，攝影機的新增、修改、刪除都透過它的 Control API（只監聽 `127.0.0.1:9997`）動態寫入。
- 每個碼流是一個 path：`<攝影機 ID>/main`、`<攝影機 ID>/sub`，來源是相機的 RTSP。
- 來源一律常駐拉流（不是有人看才連），因為錄影與偵測本來就一直在讀。

### 誰從轉發層讀

| 使用者 | 讀哪個碼流 | 備註 |
| --- | --- | --- |
| 錄影 worker | main | 可單台改為「錄影直連相機」，轉發層當掉也不影響錄影，但會多佔相機一條連線 |
| 偵測 worker | sub（沒有就用 main） |  |
| 瀏覽器即時預覽 | sub / main | 經 ffmpeg 封裝成 fMP4，見「即時預覽」 |
| Home Assistant | main | HA 的 camera 實體 stream\_source 指向這裡 |
| HKSV | main |  |
| 外部裝置 | 任一 | VLC、其他 NVR、電視牆等 |

### 對外網址與驗證

- 網址：`rtsp://<帳號>:<密碼或 Token>@<NVR>:8554/<攝影機 ID>/main`（或 `/sub`）。前端攝影機頁面提供「複製網址」按鈕。
- MediaMTX 設為 HTTP 驗證（`authMethod: http`），每次連線都回問 CookieNVR 內部端點；帳密或 API Token 通過就放行（所有帳號都能讀全部攝影機）。
- 本機內部 worker 使用啟動時產生的隨機內部帳密，不對外。
- 只開讀取；不接受外部推流。前端可整個關閉對外 RTSP。

### 取捨

內建 MediaMTX 等於多綁一個元件，與 Frigate 內建 go2rtc 類似。選它而不是用 TS 自寫 RTSP 伺服器，是因為 RTSP/RTP 的邊角情況多（TCP/UDP、各家相機的 SDP 怪癖），成熟實作比自寫穩。風險控制在三點：它是獨立 worker，有記憶體上限與 watchdog；只用它的轉發功能，錄影與偵測仍由 CookieNVR 自己做；錄影可單台切換成直連相機（多佔一條相機連線，Tapo 的連線上限在 M1 實測後再決定預設值）。

## 錄影

每台攝影機 24 小時連續錄主碼流，切成固定每段 60 秒的 fragmented MP4，影像不轉碼。保留策略區分「一般連續錄影」與「有事件的片段」，空間不足時從最舊的開始刪。

### 切片方式

- ffmpeg segment muxer：`-c:v copy`、`-segment_time 60`、`-segment_atclocktime 1`（對齊整分）、`-reset_timestamps 1`。
- 格式用 **fragmented MP4**（`frag_keyframe+empty_moov+default_base_moof`）。ffmpeg 中途當掉時，已寫入的部分仍可播放；一般 MP4 沒有寫完 moov 就整段壞掉。
- 音訊：開啟時轉 AAC 64 kbps（MP4 不能放 Tapo 的 PCM A-law）；串流沒有音訊就略過。
- 檔名一律用 UTC：`<儲存路徑>/<攝影機 ID>/<YYYYMMDD>/<HHMMSS>.mp4`，顯示時再換成瀏覽器的時區，避免時區與夏令時間問題。ffmpeg 的檔名時間取自程序的本地時區，所以錄影 ffmpeg 一律以 `TZ=UTC` 啟動，不受容器的 `TZ` 影響。
- 日期目錄由後端預先建好（今天與明天），因為 ffmpeg 不會自己建目錄。

### 索引

- 每 10 秒掃描一次今天與昨天的目錄：新檔案一出現就寫入 `segments` 表（開始時間取自檔名，`end_ms` 留空代表錄製中）；出現更新的檔案後，前一個補上結束時間（取自 mtime）與檔案大小。
- 錄製中的片段也能回放（fMP4 已寫入的部分可讀），所以回放可以一路接到幾秒前。
- 啟動時做一次完整對帳：磁碟上有、資料庫沒有的補登記；資料庫有、磁碟沒有的刪掉。

### 保留策略（每 10 分鐘執行）

| 規則 | 預設 | 說明 |
| --- | --- | --- |
| 連續錄影保留 | 7 天 | 沒有事件的片段超過就刪 |
| 事件保留 | 30 天 | 與事件（含前後緩衝）重疊的片段，以及事件本身與縮圖（事件依結束時間計算，進行中的不刪） |
| 最低剩餘空間 | 5 GB | 磁碟快滿時從最舊的刪，不管有沒有事件，優先於上面兩條 |

事件前後緩衝固定各 5 秒，用於保留判斷與回放起點，不提供調整。

錄影可以在前端或 HA 中單台關閉；關閉後仍保留即時預覽與動作偵測。

## 動作偵測與事件

偵測在 320×180 灰階、每秒 5 張的子碼流畫面上做背景差分，一台攝影機的運算量約每秒 30 萬像素，不需要 GPU。也可以改用相機內建的偵測（ONVIF 事件），或兩者並用。

### 偵測來源

| 來源 | 運作方式 | 適合 |
| --- | --- | --- |
| 畫面差分（預設） | ffmpeg 解碼子碼流、縮圖、轉灰階後輸出 raw frame，偵測 worker 計算 | 所有攝影機；可用遮罩 |
| 相機事件（ONVIF） | 訂閱 ONVIF PullPoint，收 `IsMotion` / `IsPeople` 等布林值 | Tapo、支援 ONVIF 事件的相機；不做差分計算 |
| 兩者並用 | 任一來源觸發就算 | 想要不漏接 |

不論偵測來源或偵測開關，detect worker 的解碼程序都常駐，因為快照、事件縮圖、HA 與 HKSV 的快照都靠它；關閉偵測或只用 ONVIF 時只是跳過差分計算。

### detect worker（`src/detect/`）

- 每台啟用的攝影機一個 `detect:<id>`，經 supervisor 執行 `bun src/detect/worker.ts`。worker 內的 ffmpeg 讀轉發層的子碼流（沒有子碼流用主碼流縮小），只解碼一次、輸出兩路：每秒 5 張 320×180 灰階 raw（stdout）與每秒 1 張 640 寬 JPEG（fd 3）。差分在 worker 裡算，主程序只收結果：每張畫面一筆 `{at, state, score, motion}` 與每張 JPEG，以「1 位元組種類＋4 位元組長度」的格式寫在 worker 的 stdout。
- 設定的下行通道是控制檔 `<dataDir>/detect/<id>.json`（supervisor 不給 worker stdin）：差分開關、門檻、最小面積、遮罩、鏡頭是否移動中。主程序先寫暫存檔再改名，worker 每張畫面重讀一次，所以改設定、畫遮罩都不重啟 worker。改門檻、遮罩或開始差分時重設背景。
- 卡死判定：15 秒沒有新畫面（啟動後 20 秒寬限）。
- 快照 `GET /api/cameras/:id/snapshot.jpg` 回最新一張 JPEG（`x-snapshot-at` 是取得時間）；還沒有畫面時最多等 5 秒；30 秒內都沒有新畫面（連不上）回 503；攝影機不存在或已停用回 404。
- 鏡頭移動中（`ptz.isBusy`，含停止後 3 秒）主程序在控制檔標記暫停，worker 回報 `paused` 不計分；恢復時重設背景並重新暖機 10 張。
- 實測（Apple Silicon macOS，假相機 640×360、10 fps 子碼流，5 分鐘平均）：一台的 detect worker 約 CPU 1.8%（Bun 0.8%、ffmpeg 1.0%，單核百分比）、常駐記憶體約 122 MB（Bun 39 MB、ffmpeg 83 MB），遠低於 384 MB 上限。
- 實測延遲：物體出現在推流畫面到事件建立約 2.1 秒；判定本身（連續 2 張）不到 0.4 秒，其餘是編碼、兩層 RTSP 與解碼。相機事件從收到 true 到事件建立約 10 毫秒。
- 物體離開後會留下約 5 秒的「殘影」：它掃過的區域已被背景部分吸收，消失時那塊和背景又不一樣，所以事件結束時間會比物體離開晚幾秒。

### 影像硬體解碼（`src/hwcodec/`）

- 只有 detect worker 在解碼影像（錄影、即時預覽、匯出、HKSV 都是 `-c copy`；測試連線的單張畫面與 HomeKit 快照縮放是一次性的小 JPEG，開硬體的成本比省下的多）。編碼 H.264／H.265 的工作目前沒有，所以只有「解碼」一個設定 `settings.devices.decode`：`auto`（預設，依序 Nvidia、Intel，沒有可用的顯示卡就用處理器）、`cpu` 或裝置識別字，和物件辨識同一套（`nvidia:GPU-<uuid>`、`intel:GPU.<n>`，Intel 比照 OpenVINO：PCI 00:02.0 的內顯是 GPU.0，其餘依 PCI 位址）。舊資料沒有這欄時是 `auto`。
- 值不值得：Apple M 系列實測整條 detect 指令每秒耗的 CPU（單核百分比，軟體 → VideoToolbox）：640×360 15 fps H.264 子碼流 1.3% → 0.7%；1080p 20 fps H.264 7.2% → 2.2%；1440p 15 fps H.265 12.4% → 2.2%。有子碼流時幾乎省不到，只有主碼流、或高解析度 H.265 的攝影機才明顯有用；預設仍是 `auto`（使用者決定），硬體失敗會自動退回處理器。
- 能力偵測：選了 `cpu` 以外才做。對每張卡用 CPU 產生的 640×360 短片實際試跑 H.264、H.265 的解碼與編碼（Intel 走 VAAPI 的 render node，Nvidia 走 CUDA，以 `CUDA_VISIBLE_DEVICES=<uuid>` 指定那一張），不看編譯選項。解碼一律 `-hwaccel_output_format` 加 `hwdownload`：硬體失敗時 ffmpeg 會默默改用軟體，hwdownload 收不到顯示卡的畫面就讓它失敗，所以「成功」代表真的在那張卡上解。結果在 `GET /api/video-devices`（管理員，`?refresh=1` 重跑）；編碼結果只供參考與診斷。
- 規劃（`planDecode`，純函式）：依設定、試跑結果與這台 detect 碼流的格式（MediaMTX 回報的軌道）挑卡；選的卡不支援這個格式或試跑失敗用 CPU，選的卡不見了改用自動，都附原因。試跑完成前先用 CPU，完成後 worker 規格改變而重啟一次。CPU 時 worker 指令和以前完全一樣。
- 執行中的退回：worker 經環境變數 `DETECT_HW_DECODE` 收到要用的卡。硬體路徑在第一張畫面前就結束或 10 秒沒有畫面時，同一次執行內改用 CPU 重開 ffmpeg，偵測與快照不中斷；等 CPU 真的解出畫面才回報原因（相機連不上時不冤枉顯示卡）。下次 worker 重啟會再試硬體。硬體路徑不帶 `-fflags nobuffer`：VideoToolbox 在 nobuffer 下對同一條串流每張都解碼失敗且 ffmpeg 不結束。
- 狀態：`GET /api/system` 的 `decode`（每台用哪張卡、是否已確認有畫面、退回原因，以及給狀態頁的一句 `warning`）。`warning` 有值時，狀態頁多一張黃色問題卡「影像解碼改用處理器」（內容用該句，動作連到設定 → 一般），側欄與首頁的問題數也算進去（`web/health.ts` 的 `decode`）；ffmpeg 的原始訊息只放診斷資訊的「影像硬體解碼」一節。
- 設定畫面：「設定 → 一般」的物件辨識下方有一列「影像解碼」，選項是「自動（預設）」「處理器」加上 `GET /api/video-devices` 的每張顯示卡（名稱優先用 `GET /api/objects` 裡同 id 的型號）。H.264 與 H.265 都不能解的卡選項停用並以副標顯示原因，只有一種不行時副標寫「不支援 H.265」之類；沒有顯示卡時仍顯示，只有自動與處理器。列底下依 `decode.cameras` 寫「使用中：…」，退回處理器時用警示色顯示 `fallback.reason`，ffmpeg 訊息不上畫面。
- macOS 開發機會列出 `apple:0`（VideoToolbox），只用來在開發機走通硬體路徑。
- 實機檢查：容器內 `video-selftest`（`scripts/video-selftest.ts`），步驟在 `detector/README.md`。Intel 與 Nvidia 的路徑在開發機跑不到，尚未實測。

### 畫面差分演算法

1. 3×3 模糊去噪。
2. 與背景模型比較，差值超過「像素門檻」（預設 25/255）算變動像素。
3. 畫面切成 8×8 區塊，區塊內變動像素超過 25% 才算「活動區塊」，濾掉零星雜訊。
4. 分數 = 活動區塊 ÷ 未遮罩區塊；超過「最小面積」（預設 0.5%）算有動作。
5. 背景以滑動平均更新（α = 0.05）。差值每張乘 0.95，靜止物體吸收的時間取決於對比：中等對比約 4 秒（實測黑色方塊停在彩條上 4.4 秒），白色物體在暗處這種 160 的落差要 7 秒。
6. 分數超過 70% 視為光線突變（開燈、切換夜視），重設背景且不觸發。
7. 啟動或重連後的前 10 張不判斷。

3 的細節：區塊內未遮罩的像素不到 25% 就不納入計算，遮罩邊緣的碎塊才不會變成雜訊；分母是納入計算的區塊數。

### 遮罩

- 在前端的快照上點選畫多邊形，座標存成 0–1 的比例值，換解析度不用重畫。單台最多 16 個、每個 3 到 32 個頂點；以像素中心的奇偶規則畫進 320×180 的點陣。
- 遮罩內的像素不參與計算（例如馬路、樹、時間浮水印）。
- 單台可設多個遮罩；只影響畫面差分，不影響 ONVIF 事件。

### 事件生命週期

1. **開始**：連續 2 張有動作（或收到 ONVIF true）→ 建立事件（開始時間是第一張有動作的畫面）、下一張快照（1 秒內）存為縮圖、通知 HA 與 HKSV。
2. **進行中**：記錄最高分數，分數創新高時用下一張快照取代縮圖。
3. **結束**：連續「冷卻時間」（預設 10 秒）沒有動作 → 結束時間寫最後一次有動作的時間、通知 HA。相機事件為 true 期間一直算有動作，收到 false 才開始冷卻。
4. 事件最長 10 分鐘，超過就在當下切成新事件，避免一整晚只有一筆。
5. 同一台同一時間只有一筆事件：畫面差分與相機事件並用時，任一來源先觸發就建立，另一來源在進行中觸發就併入，`source` 記為 `both`。相機事件的人形、車輛、寵物記進 `labels`（person、vehicle、pet）。
6. 關閉偵測或拿掉某個來源、刪除攝影機、主程序結束時，進行中的事件立刻收尾。主程序當機留下沒結束的事件，下次啟動時以「現在」收尾，但不超過開始後 10 分鐘。
7. 狀態機是純函式（`src/events/lifecycle.ts`），資料庫、縮圖與通知在 `src/events/tracker.ts`。

### 相機事件（ONVIF）

- 主程序對每台需要的攝影機開一個 `OnvifClient` 與 PullPoint 訂閱器（自動續約、斷線退避重連），端點設定變動時停掉舊的再建新的。
- 動作、人形、車輛、寵物、越線會觸發；遮蔽（Tamper）與 Tapo 自訂的智慧事件不觸發，只在診斷資訊列為最近一次通知。
- `PropertyOperation="Initialized"` 是訂閱當下的狀態，不算新事件；沒有布林值的通知忽略。訂閱中斷時視為相機回報的狀態都已結束，免得漏收的 false 讓事件一直開著。
- 診斷資訊列出訂閱狀態：`unsupported`（相機不支援 PullPoint，已停止）、`backoff` 且錯誤是 `auth` 時提示檢查帳密。

### 行程內的事件訂閱

`src/events/` 匯出 `EventFeed`：`subscribe(listener)` 收 `{phase: "start" | "update" | "end", event}`（update 是分數創新高、換了縮圖、來源或標籤改變），`active()` 回進行中的事件。HA 整合、HKSV、物件辨識都從這裡訂閱；SSE 的 `event` 與 `motion` 訊息也是由它轉送（update 只在 labels 改變時推）。

可調參數（都在前端，存在攝影機設定的 `detect` 欄位；舊資料沒有這欄時用預設：開啟、畫面差分、門檻 25、最小面積 0.5%、冷卻 10 秒、沒有遮罩）：偵測開關、來源、靈敏度（低、中、高對應像素門檻 35、25、15，其他值顯示為自訂）、最小面積、冷卻時間、遮罩。前端的偵測設定頁用 `GET /api/cameras/:id/motion`（SSE）即時顯示分數曲線，觸發線就是最小面積。

## 物件辨識（YOLO，選用）

動作偵測回答「有沒有東西在動」，物件辨識回答「動的是什麼」。YOLO 只在有動作時才跑，用來替事件加上類別（人、車、動物等），或濾掉不是指定類別的誤報。預設關閉；關閉時 detector worker 完全不啟動。推論程序當掉時系統退回純動作偵測，錄影完全不受影響。

### 推論裝置

| 裝置 | 執行方式 | 映像 | 容器需求 |
| --- | --- | --- | --- |
| Intel 內顯 | ONNX Runtime ＋ OpenVINO plugin EP（`onnxruntime-ep-openvino`） | `latest`（只有 amd64） | 掛入 `/dev/dri` |
| Nvidia 顯卡 | ONNX Runtime ＋ CUDA 12（`onnxruntime-gpu` 1.26） | `latest-nvidia`（只有 amd64） | NVIDIA Container Toolkit，`--gpus all` 或 `runtime: nvidia`；主機驅動 525 以上 |
| CPU | ONNX Runtime | 兩者皆可（arm64 只有 CPU） | 無 |

- detector 啟動時列出這個環境實際偵測到的每個裝置：CPU、每顆 Intel 內顯（OpenVINO 的 `GPU.0`、`GPU.1`）、每張 Nvidia 卡，各帶型號。每個裝置有穩定的識別字：`cpu`、`intel:GPU.0`、`nvidia:GPU-<uuid>`（nvidia-smi 的 UUID，重開機或換插槽不變；沒有 nvidia-smi 時退而用 `nvidia:<編號>`）。CUDA 以 PCI 順序編號，和 nvidia-smi 一致。
- 設定存成「工作 → 裝置」的對應 `settings.devices`（`objects` 是這裡的推論，`decode` 是影像解碼，見「影像硬體解碼」），值是 `auto`、`cpu` 或識別字。在「設定 → 一般 → 物件辨識」選擇，預設「自動」：依序試 Nvidia、Intel、CPU。不提供「不同攝影機用不同裝置」：所有攝影機共用一個推論程序，一次一張，分裝置要多開程序與佇列，這一版不做。
- 指定或自動選到的 GPU 載入失敗時改用下一個（最後是 CPU）；指定的裝置不見了（拔卡、換卡）改用自動。實際使用的裝置與原因回報給主程序，顯示在設定頁（「使用中：Intel UHD Graphics 630」與警示）與診斷資訊。
- 分成兩個映像：官方文件說同一個環境只能裝一種 ONNX Runtime 套件，而且 Nvidia 的 CUDA／cuDNN 函式庫壓縮後就有約 1.7 GB。-nvidia 釘在 CUDA 12（`onnxruntime-gpu` 1.26.0、cuDNN 9.11），涵蓋 Maxwell 以後的卡（家用常見的 Pascal，例如 P400、GTX 10 系列）；cuDNN 9.12 起只支援 Turing 以後，所以不升級。要 CUDA 13 可用 build arg `ONNXRUNTIME_GPU`。TensorRT 需要另外數 GB 的函式庫與建引擎時間，不放。
- Intel 內顯需要容器內的 OpenCL 驅動：Debian trixie 沒有打包，映像內並裝 Intel compute-runtime 26.40（Gen12 以後）與 24.35 的 legacy1 套件（Gen8 到 Gen11，例如 8 到 10 代 Core 的 UHD 630、J4125），下載時驗 SHA-256。
- Nvidia 卡的使用率與顯示記憶體由 detector 每 10 秒以 nvidia-smi 讀取，主程序以 `ObjectDetection.resources()` 匯出給狀態頁；Intel 內顯沒有便宜的讀法，不提供。

### 模型

- 格式為 ONNX。內建 YOLOX-Tiny（Apache-2.0，官方 0.1.1rc0 release 的 `yolox_tiny.onnx`，輸入 416×416，COCO 80 類）。官方沒公布雜湊，建置時下載並比對我們釘住的 SHA-256（`detector/builtin-model.json`）。選 Tiny 的理由：Apple Silicon 4 執行緒實測每張約 12 ms（Nano 7 ms 但信心明顯較低，S 34 ms），在一般家用 x86 CPU 上預期仍在數十毫秒內。
- Ultralytics YOLO 是 AGPL-3.0，不內建。使用者可把自己的 ONNX 模型放進 `/data/models/` 並在前端選用，支援 YOLOX（`[1, N, 5+C]`）、Ultralytics YOLOv8 / 11（`[1, 4+C, N]`）與內含 NMS 的 `[1, K, 6]`（例如 YOLO26）。格式以實際跑一張空白畫面的輸出形狀判斷；看不懂時 worker 不結束，回報中文錯誤顯示在設定頁。
- **類別鍵**：模型的類別名稱轉成小寫英文、數字與底線（`traffic light` → `traffic_light`），設定的 `detect.labels`、事件的 `labels`、`GET /api/objects/labels` 都用這套鍵。自備模型的類別名稱讀 metadata 的 `names`，沒有才當作 COCO 80 類；任意名稱都照原樣轉鍵傳遞，有中文翻譯就顯示中文，沒有就顯示原名。
- **包裹**：內建模型是 COCO 80 類，沒有包裹（只有背包、手提包、行李箱這類不同的東西，不拿來冒充）。要辨識包裹需要放入含這個類別的自備模型；類別名為 package、parcel 時會自動顯示為「包裹」，也會出現在勾選清單與 HA 感應器。
- 前端預設列出常用類別（人、汽車、機車、腳踏車、卡車、公車、貓、狗、鳥），其餘收在「更多類別」。

### 流程

1. 物件辨識開啟、且這台不是「不辨識」時，detect worker 依辨識頻率輸出 640 寬 JPEG（每秒 1 到 5 張；沒開的攝影機維持每秒 1 張，不多編碼）。主程序已經收這些 JPEG 當快照，所以畫面由主程序轉交 detector（不另開一條 detect → detector 的通道），只在這台有動作（等待辨識或有進行中的事件）時才送，並依頻率節流。
2. detector worker（`detector/main.py`，Python）由所有攝影機共用，經本機 Unix socket（`/tmp/cookienvr-<pid>-detector.sock`，路徑放 `/tmp` 是因為 macOS 的 socket 路徑上限約 104 字元）與主程序交換「1 位元組種類＋4 位元組長度＋內容」的訊息。一次處理一張；佇列在主程序，排隊超過 1 秒的畫面直接丟掉並計數。
3. 某類別的信心值超過門檻（預設 0.5）且連續 2 張出現，才寫入事件的 `labels`，並立刻發出事件的 update（SSE 也推送）。縮圖換成信心值最高的那一張辨識畫面；之後動作分數再高也不換。
4. 物件框的中心落在遮罩內就忽略，與動作偵測共用同一組遮罩。
5. 卡死判定：心跳每 2 秒一次，10 秒沒有訊息、或一張推論超過 10 秒就重啟；載入模型最多等 3 分鐘（GPU 第一次編譯）。模型格式錯誤時 worker 只回報錯誤並持續心跳，不讓 supervisor 反覆重啟。

### 辨識頻率

「每秒辨識幾次」是全域設定 `objects.fps`，選項：每 2 秒 1 次、每秒 1、2（預設）、3、5 次，指的是每台攝影機有動作時。用全域而不是每台各自設定，因為瓶頸是共用的推論程序，測速的結論也是「幾台 × 每秒幾次」。「連續 2 張」的規則不變；過濾模式的等待期限是 max(3 秒, 2 張的間隔＋1 秒)，頻率很低時不會還沒等到第 2 張就丟棄。

### 測速

- 管理員在設定頁按「測速」，可選要測哪些裝置（預設目前使用的）。detector 在每個裝置上用內建測試圖（640 寬 JPEG，和實際送來的一樣）先暖機 1.5 秒，再連續推論 10 秒，量每秒幾張（含解碼與前後處理）。測速期間暫停辨識（事件照常由動作建立，過濾模式暫時當作標註），有進度、可取消，結果存在 `/data/detector-benchmark.json`，換了模型或測過的裝置都不在時標示過期。
- 換算成「大約可以同時處理幾台攝影機」：測得的速度是最佳情況，CPU 只算一半（錄影、解碼與動作偵測也在用），GPU 算八成（解碼與前後處理仍在 CPU）；物件辨識只在有動作時才跑，所以這是「同時有動作」的台數。結論對照目前開了物件辨識的攝影機數與辨識頻率，說明夠不夠用。
- 執行時持續量測最近 60 秒每秒實際推論幾張、最近 5 分鐘被丟掉的比例；丟掉超過一成，或測速結論顯示同時有動作時會來不及，在設定頁與狀態頁用白話提醒，並建議降低頻率或更換裝置。
- `detector-selftest` 輸出同樣的測速與換算，實機上不用開介面也拿得到數字。

### 模式（單台設定）

設定在每台的偵測設定裡：模式、關注的類別（`detect.labels`）、信心門檻（介面顯示為「嚴格程度」）。系統沒開物件辨識時這些設定不出現。

| 模式 | 行為 |
| --- | --- |
| 不辨識 | 這台不送畫面去辨識 |
| 標註（預設） | 事件照常由動作建立，辨識結果只是替事件加上類別 |
| 過濾 | 動作觸發後先等辨識，期限內出現勾選的類別才建立事件並通知 HA 與 HKSV，否則丟棄（不寫資料庫、不發 start） |

過濾模式下 detector 無法使用（啟動中、重啟中、模型錯誤、測速中）時，自動退回標註模式的行為，寧可多報也不漏報；等待中的動作立刻建立事件。狀態機仍是純函式：等待中是 `pending` 狀態，期限與是否過濾由呼叫端以 `Policy` 傳入。

對外（`GET /api/cameras` 與 SSE）的 `config.detect.labels` 是「目前生效的」類別：系統沒開物件辨識或這台設為不辨識時是空陣列，HA 依這個清單為每個類別建立感應器。存起來的勾選不受影響：沒開時用戶端送回空清單也會保留原值。

### 實機驗證

GPU 路徑在開發機（arm64 Mac）無法執行。`detector/README.md` 是實機測試步驟：在 amd64 機器上建置兩個映像、Intel 與 Nvidia 的啟動方式、在容器內執行 `detector-selftest [--expect intel,nvidia 或裝置識別字]`。自我檢查列出每個裝置、在每個裝置上推論並測速、比對與 CPU 的結果是否一致，最後印出可直接貼給 AI 的摘要；失敗時附可能原因與下一步。

## 即時預覽

瀏覽器用 MSE 播放 fragmented MP4 串流，影像不轉碼、不需要 WebSocket 或 WebRTC。fragment 每 200 毫秒切一次，延遲不受關鍵幀間隔限制：假相機實測端到端約 0.45–0.75 秒（headless Chrome，畫面內嵌時鐘），Tapo 估計約 0.3–1.1 秒（只能用相機畫面上的秒級時間與相機時鐘比對）。

### 串流方式

- 每個碼流有一個 ffmpeg live worker，從轉發層讀取後 `-c copy` 封裝成 fMP4（遇到關鍵幀必定切開，另外每 200 毫秒切一次），輸出到 stdout，只取影像。
- supervisor 平常把 worker 的 stdout 與 stderr 都收進輸出尾端（MediaMTX 的日誌寫在 stdout），所以 `WorkerSpec` 可以宣告 `readStdout`：宣告後 stdout 是資料，每次啟動都把該次的 stdout 整條交給它讀，不進尾端，stderr 照舊。選它而不是本機 socket，是因為 pipe 跟著子程序的生命週期走，一次執行就是一條串流，重啟的分界不用另外對齊，也不用管 port 或 socket 檔。
- 主程序解析 MP4 box：保留 init segment（ftyp + moov）與最近一個關鍵幀以來的 fragment（一個 GOP）。
- 新觀看者連上時先收 init＋這個 GOP，立刻有畫面；之後持續收新 fragment。
- 傳輸用一般 HTTP chunked：`GET /api/cameras/:id/live.mp4?quality=sd|hd`，等到 init 才回應，標頭 `X-Codec` 帶上從 moov 解出的 codec 字串（例如 `avc1.640028`）。這個回應只承載一次 worker 執行：worker 重啟時連線結束，前端重連。
- 多宮格用 `GET /api/live?cameras=<id>,<id>&quality=sd`，把多台攝影機包在同一條回應裡（每個 frame 是 1 byte 種類、1 byte 攝影機序號、4 byte 長度與內容；種類有資料、重新開始、沒有串流、保持連線）。瀏覽器對同一主機的 HTTP/1.1 只開 6 條連線，一台一條的話 5 台以上就會卡住其他請求。
- 讀太慢的觀看者（積壓超過 4 MB）直接斷線，不拖累其他人。
- 前端每半秒檢查播放位置：落後即時邊緣超過 0.5 秒就以 1.1 倍速追上，超過 1.5 秒直接跳到邊緣。追趕門檻再低（0.3 秒）延遲可再少約 0.2 秒，但實測會頻繁卡頓。
- 連線中斷、worker 重啟都會自動重連（退避 0.5 秒起、最長 10 秒）；分頁隱藏時關閉串流，回到分頁再接上。實測強制結束 live ffmpeg 後約 4 秒恢復畫面（含 supervisor 的 2 秒退避）。

### 畫質與資源

| 畫質 | 來源 | 何時運作 |
| --- | --- | --- |
| SD（預設） | 子碼流（沒有子碼流就用主碼流，與 HD 共用同一個 worker） | 有人在看才啟動，最後一人離開 30 秒後停止 |
| HD | 主碼流 | 同上 |

多宮格頁面一律用 SD（靜音自動播放，載入前與無法播放時顯示快照）；點卡片進單台頁面：大畫面、可切「標準／高畫質」（記在這台瀏覽器）、「看回放」直接開這台的回放。音訊第一版不放進即時預覽。

### 限制

- H.265 是否能播取決於瀏覽器與硬體；不支援時畫面上顯示「這個瀏覽器無法播放 H.265 即時畫面」並改用每 3 秒更新的快照，不自動轉碼。ffmpeg 從 RTSP 複製 H.265 時寫成 `hev1`，Safari 的 MSE 可能只接受 `hvc1`，尚未實測。
- iPhone 沒有 `MediaSource`，前端在 iOS 17.1 以上改用 `ManagedMediaSource`（回放相同）；兩者都沒有時顯示說明，改用每 3 秒更新的快照。
- 快照：偵測 worker 同時每秒輸出一張 640 寬的 JPEG，`/snapshot.jpg` 直接回傳記憶體中的最新一張。

## 回放系統

回放是一個以「實際時間」為軸的播放器：拖到哪個時刻就播哪個時刻，跨片段無縫接續，支援 1–16 倍速與時段匯出。

### 畫面配置

- **上方**：攝影機選擇、日期（月曆上標出有錄影的日子，沒有錄影的日子不能選；前一天、後一天會跳過沒有錄影的日子）、倍速（控制列上的下拉選單）、匯出。
- **中間**：播放器，按鍵操作：空白鍵播放／暫停、← → 前後 10 秒、`[` `]` 上／下一個事件。
- **下方時間軸**：灰色條是有錄影的時段、空白是缺片、色塊是事件；可縮放 24 小時／6 小時／1 小時／10 分鐘，可拖曳。滑鼠停在事件上顯示縮圖。
- **右側事件清單**：當天事件的縮圖與時間，點一下跳到事件開始前 5 秒。
- **網址**：`/recordings?camera=<攝影機 id>&date=<YYYY-MM-DD，瀏覽器時區>&t=<epoch 毫秒>`，三個都可省略（第一台、最近有錄影的一天、今天最新或那天第一段）。事件頁的連結帶齊三個。播放中至多每 5 秒、暫停與跳轉時立刻把位置寫回 `t`（取代目前的歷史紀錄，不新增），重新整理會從原處接著播；換攝影機新增一筆歷史紀錄，換日期不新增。

### 播放器原理

1. 時間軸原點設為當天 00:00（依瀏覽器時區），播放器的 currentTime = 距原點的秒數。
2. 每個片段用 MSE 加入同一個 SourceBuffer。檔名時間只有秒級精度，切點又落在關鍵幀，直接拿來定位會在片段之間留下空隙或重疊，所以連續的片段一律接在前一段的結尾；只有前後相差超過 2 秒（真的缺片）或跳轉後的第一段，才用 `timestampOffset` = 片段開始時間 − 原點重新定位。因此片段之間沒有切換黑屏。
3. 只預先載入播放位置前後的片段；倍速越高預載越多，播過的部分從緩衝區移除以控制記憶體。高倍速是否流暢取決於裝置的解碼能力。
4. 遇到缺片自動跳到下一個有錄影的時刻，時間軸上標出跳過的範圍。
5. 錄製中的片段用 HTTP Range 持續追加新寫入的位元組，回放可以一路播到現在。
6. 跨日：播到 23:59 自動切到隔天。

### 匯出

- 選取：時間軸卡片標題列的「匯出」開啟選取模式，預設選播放位置起 1 分鐘；桌面在時間軸上拖曳選取，拖曳兩端的把手微調；手機（或不想拖曳時）用「設為開始」「設為結束」把目前播放位置當作起訖。選取列顯示長度與預估大小。事件清單每一筆有一鍵匯出按鈕，範圍為事件前後各 5 秒。
- 後端用 ffmpeg concat＋`-c copy` 接成一個一般 MP4（`+faststart`），不重新編碼，所以音訊保留，切點對齊關鍵幀：開頭可能早到一個 GOP，長度與選取範圍的誤差約 1–2 秒。檔名為 `<攝影機名稱>_<YYYYMMDD>-<HHMMSS>.mp4`，時間是開始時間（依瀏覽器時區）。
- 跨缺片的範圍直接把前後兩段接起來，缺片不補，匯出長度只計有錄影的部分。包含錄製中片段的範圍匯出到當下已寫入的部分，結束時間超過現在則收到現在。範圍內完全沒有錄影回 422「這段時間沒有錄影」。
- 單次上限 2 小時，同時只跑一個匯出，其餘排隊（最多 10 筆未完成）。匯出是 export worker（ffmpeg 子程序，自成程序群組）：10 分鐘未完成、記憶體超過 256 MB 或被取消就整組終止，工作標為失敗。佇列與工作狀態只在記憶體，檔案放在 `<dataDir>/exports/`；主程序啟動時先清掉上次殘留的 ffmpeg 與暫存檔，完成或失敗 24 小時後自動刪除。
- 進度每秒輪詢 `GET /api/exports`；完成後瀏覽器直接下載 `/api/exports/:id/file`。一般使用者即可匯出，所有人看得到所有匯出工作。

## Tapo 鏡頭控制（PTZ）

PTZ 走標準 ONVIF（Tapo 在 port 2020），所以同一套程式也能控制其他支援 ONVIF PTZ 的攝影機。前端、HA、API 都能操作。

### ONVIF 客戶端

- 自寫精簡 SOAP 客戶端（不引入套件），驗證用 WS-Security UsernameToken digest。
- 連線時先取 `GetSystemDateAndTime` 算出與相機的時間差，避免相機時鐘不準導致驗證失敗。
- 用 `GetCapabilities` 找出 Media、PTZ、Events 的服務位址，不寫死路徑；再用 `GetProfiles` 取 profile token。
- 結果（是否有 PTZ、支援哪些移動方式）快取在記憶體，失敗時重新探測。

### 操作方式

| 操作 | ONVIF 指令 | 前端交互 |
| --- | --- | --- |
| 持續移動 | `ContinuousMove` + `Stop` | 按住方向鍵／拖曳畫面，放開停止 |
| 微調 | `RelativeMove` | 點一下方向鍵 |
| 預置點：前往 | `GotoPreset` | 預置點清單 |
| 預置點：儲存／刪除 | `SetPreset` / `RemovePreset` | 預置點清單旁的按鈕 |
| 變焦 | `ContinuousMove` 的 Zoom 軸 | 有變焦的相機才顯示 |

- 速度可調（0.1–1.0）。
- 移動模式預設「自動」：先試 ContinuousMove，相機回錯就改用 RelativeMove 並記住。也可在前端手動指定。
- 安全停止：前端按住時每 500 ms 送一次 move；後端 1.5 秒沒收到就自動 Stop，網路斷掉也不會一直轉。
- 所有使用者都能操作 PTZ，儲存／刪除預置點限管理員。

### 前端介面（`web/ptz/`）

- 只有相機支援（`GET .../ptz` 回 `supported: true`）才出現控制盤；不支援時單台頁面與沒有 PTZ 時完全相同。暫時連不上（503、504、502）只在畫面下方放一行「暫時無法控制鏡頭」與重試鈕。
- 版面：桌面與橫向螢幕（寬 ≥ 900，或橫向且寬 ≥ 640）把控制盤放在畫面右側，不遮住畫面；直向手機放在畫面下方並貼近底部導覽列，單手拇指按得到。
- 方向鍵按下後 250 ms 內放開是「點一下」（有相對移動就送 `RelativeMove`，只有持續移動則動 200 ms 後停止），超過就是按住（`ContinuousMove`，每 500 ms 重送，放開送 Stop）。只支援相對移動的相機，或偏好設為「點一下一步」時，按一下送一步，不做按住。偏好要求相機做不到的方式時忽略偏好。變焦只在相機支援時出現，點一下一律是持續移動 200 ms。
- 滑鼠、觸控與鍵盤（方向鍵、`+`／`-`，聚焦在按鈕上時 Space／Enter）都能操作，可同時按兩個方向走斜線。任何會中斷按住的情況（指標離開或取消、視窗失焦、分頁隱藏、離開頁面、重新整理或關閉分頁、任一次 move 失敗）一律送 Stop；中間的「停止」鈕不管狀態都送 Stop。狀態機在 `driver.ts`（計時器與傳輸層可注入，有單元測試）。
- 速度滑桿預設用攝影機偏好，只在這一頁有效，不寫回設定。
- 預置點：清單點名稱就前往。管理員另有「儲存目前位置」（命名）與「編輯」模式（覆寫成目前位置、刪除，兩者都要確認）；達到上限時停用新增並說明。一般使用者沒有預置點時整段不出現。
- 設定攝影機的進階設定多一段「鏡頭控制」（移動方式、預設速度），只在這台已知支援時顯示；測試連線成功且 `onvif.ptz` 為真時，成功畫面多一句說明。

### 後端實作（`src/ptz/`）

- 每台攝影機一個長期存在的 `PtzController`（自動模式學到的結果與安全停止的計時才會延續），ONVIF 連線設定（Tapo 由主機推導，host 欄的 RTSP 埠忽略）變動或攝影機刪除時釋放並重建；移動中被釋放（含主程序關閉）會先送 Stop。只改名稱、PTZ 偏好不重建。
- `GET /api/cameras/:id/ptz` 回能力（持續、相對、變焦、預置點上限）、預置點清單與該台偏好；沒設定 ONVIF 或相機沒有 PTZ 回 `{ supported: false, reason }`，不是錯誤。`POST` 的 body 是 `{ action: "move" | "stop" | "preset", ... }`，move 的 pan／tilt／zoom 各 −1 到 1（至少一軸非 0）、`speed` 0.1 到 1.0、`mode` 為 auto／continuous／relative，沒帶就用攝影機偏好；請求的 mode 與偏好不同時各自有一個控制器，Stop 會取消全部的安全停止。`POST`／`DELETE .../presets` 的 body 為 `{ name, token? }`、`{ token }`；沒帶 token 是新增，超過相機回報的上限回 409。
- 錯誤：連不上 503、逾時 504、帳密錯誤與相機回錯 502（不能用 401，前端遇到 401 會登出網站）、相機沒有 ONVIF／PTZ／變焦或不支援該模式 409、預置點不存在 404。訊息一律是中文，不含相機回傳的英文原文與密碼。
- 攝影機設定多一個選填的 `ptz: { mode, speed }`（預設 auto、0.5），舊資料沒有這個欄位時用預設。
- `hub.isBusy(cameraId)`：鏡頭正在移動，或剛停止不到 3 秒（持續移動以「安全停止送出後再 3 秒」為上限，手動停止、相對移動與前往預置點是「現在起 3 秒」）。動作偵測用它暫停偵測。
- 測試連線（`POST /api/cameras/test`）成功時多一個 `onvif` 欄位：`unconfigured`、`available`（含 ptz、zoom、maxPresets）或 `unavailable`（含 kind 與中文 message）。ONVIF 連不上不算測試失敗。診斷資訊每台列出 ONVIF 與 PTZ 能力、偏好與最近的錯誤種類。

### 動作偵測與 PTZ 的互動

鏡頭移動中不偵測；停止後 3 秒重設背景再繼續，避免轉鏡頭被當成動作（實作見「detect worker」）。遮罩是針對畫面位置，鏡頭轉開後會失效，偵測設定在可轉動的鏡頭上會提示這點。

### 待實機驗證

- 各 Tapo 型號（C200、C210、C500 等）對 ContinuousMove 與預置點的支援程度。
- 隱私模式、警示燈、警報音這類 Tapo 專屬功能不在 ONVIF，需要 Tapo 本機 API，列為後續版本。

## 帳號與權限

帳號只分「一般使用者」與「管理員」兩種角色，所有人都看得到全部攝影機，瀏覽器用 session cookie 登入，HA、RTSP 設備、自動化腳本用 API Token。第一次開啟網頁時建立第一位管理員。

### 角色

| 能力 | 一般使用者 | 管理員 |
| --- | --- | --- |
| 所有攝影機的即時預覽、回放、事件、快照、RTSP 讀取 | ✓ | ✓ |
| PTZ、匯出影片 | ✓ | ✓ |
| 開關錄影／偵測、刪除事件 |  | ✓ |
| 攝影機與系統設定、使用者管理、所有人的 Token、系統狀態與日誌 |  | ✓ |

- 至少保留一位管理員，最後一位不能被刪除或降級。
- 不做個別攝影機的權限：角色只決定「能看」還是「能改」。

### 密碼與登入

- 密碼用 argon2id 雜湊（Bun 內建 `Bun.password`），至少 8 個字元。
- Session token 為 32 bytes 隨機值，資料庫只存 SHA-256；cookie 設 `HttpOnly`、`SameSite=Lax`，經 HTTPS 時加 `Secure`。
- Session 有效 30 天，使用中會自動延長；「帳號 → 登入裝置」可看到並登出其他裝置。
- 改密碼時登出該使用者的其他 session。
- 登入失敗限流：同一 IP＋帳號連續失敗 5 次後開始鎖定，時間指數增加，最長 15 分鐘。
- 改變狀態的 API（POST/PUT/DELETE）只接受 JSON，加上 SameSite cookie 防 CSRF。

### 授權連結（免 Token 連接 App）

仿 OAuth 2.0 裝置授權（RFC 8628），讓 HA 這類 App 不用使用者複製 Token（`src/auth/link.ts`、`src/http/link-routes.ts`、核准頁 `/link/:code`）：

1. App 呼叫 `POST /api/link`（`{app}`），拿到給人看的短碼 `code`（`XXXX-XXXX`，20 個子音字母，約 34.6 bits）、核准網址 `approveUrl`（`<NVR>/link/<code>`，以 App 連進來的網址組成）、只有 App 知道的輪詢憑證 `pollSecret`（32 bytes）、`expiresAt`（10 分鐘）與輪詢間隔。
2. 使用者開核准網址；未登入先登入再回來。頁面顯示同一組短碼、App 名稱、請求來源 IP、允許後能做什麼（一般使用者會看到「錄影與偵測開關不會出現」），按「允許」或「拒絕」。
3. App 以 `POST /api/link/poll`（`{pollSecret}`）輪詢：`pending`、`denied`、`expired`、`claimed`，或一次性的 `approved`（附 token、帳號、角色）。Token 在被取走的當下以核准者身分建立，名稱如「Home Assistant（192.168.1.20，2026-11-19）」，出現在「帳號 → 連接其他 App」可撤銷。

安全性：
- 請求只存在記憶體，重啟後失效。只能核准一次、token 只能取走一次；知道短碼拿不到 token（要 `pollSecret`）。
- 核准只接受瀏覽器 session（API Token 不行），且必須同源：Fetch Metadata `Sec-Fetch-Site: same-origin`，沒有這個標頭的舊瀏覽器比對 `Origin`；加上全站只收 JSON 與 SameSite cookie。
- 防嵌入：核准頁在 iframe 中只顯示「請直接開啟」，不顯示按鈕；SameSite=Lax 的 cookie 在跨站 iframe 也不會送出。Bun 的 HTML bundle 路由不能加回應標頭，所以沒有 `X-Frame-Options`。
- 釣魚（別人建立請求後把核准連結傳給使用者）：核准頁顯示請求來源 IP，來源不是家用網段時加警告；按鈕在頁面出現後 0.6 秒才能按（擋誘導連點）；管理員核准時明講 App 會有完整管理權限。不要把 `/api/link` 開到外網（經反向代理時看到的來源 IP 會是代理，限流也會變成全體共用）。
- 換位址的證明：`POST /api/link/proof`（`{lookup, nonce}`）回 `HMAC-SHA256(sha256(token), nonce|instanceId)`，`lookup = sha256("cnvr-proof-id:" + sha256(token))`。App 在把 token 送往新位址前用它確認對方真的是發 token 的那台，token 本身不會送出。
- mDNS 解析器只處理 9000 bytes 以內、非回應、每段不超過 64 筆的封包，名稱不超過 255 bytes、壓縮指標只能往前指；只回答本機子網送來的查詢。
- 限流：每 IP 每 10 分鐘最多建立 10 筆、同時待核准 5 筆、全體待核准 100 筆（記憶體中含已結束最多 1000 筆）；每 IP 每分鐘輪詢 90 次、用錯輪詢憑證 10 分鐘 20 次；每位使用者查不到短碼 10 分鐘 10 次。
- 結束（拒絕、取走、過期）的請求再保留 10 分鐘讓輪詢拿到明確狀態，之後回 404。

### API Token

- 在「帳號 → 連接其他 App」（預設收合）建立，名稱如「Home Assistant」「電視牆」；完整 token 只在建立時顯示一次，格式 `cnvr_…`。
- Token 繼承建立者的角色；只想給檢視權限時，用一般使用者帳號建 token。
- 使用方式：`Authorization: Bearer <token>`；快照與串流網址另接受 `?token=`（給無法帶標頭的客戶端）；RTSP 則放在密碼欄。
- 顯示最後使用時間，可隨時撤銷。撤銷 token 或登出 session 後，用它開著的即時事件串流（`/api/stream`）會在下一次 ping（20 秒內）被切斷，HA 因此立刻進入重新驗證。

## 前端與設定

所有設定都存在 SQLite，從網頁修改後立即生效，只重啟受影響的 worker。前端為繁體中文、RWD，手機也能用。

### 技術

- React 19 + TanStack Router（檔案式路由，`web/routes/`，各頁自動分割）+ TanStack Query + Base UI，Vite 打包（`bun run build` 輸出 `dist/web`）。前端套件只在 devDependencies，後端仍不用 npm 套件。正式環境由主程序提供 `dist/web` 的靜態檔（帶雜湊的資產永久快取、`index.html` 不快取），其他非 `/api` 路徑都回 `index.html`。開發時 `bun run dev:web`（或搭假後端的 `bun run dev:mock`）由 Vite 把 `/api` 代理給後端。轉換做法見 `web/MIGRATING.md`。
- 一般路徑路由（`/cameras`、`/cameras/:id`…）。
- 共用元件在 `web/ui/`：下拉選單（`Select.tsx`，Base UI Select）、日期選擇（`DatePicker.tsx`，Base UI Popover 裡的月曆，週日開始、依瀏覽器時區）、選單（`Menu.tsx`）、對話框與確認（`Dialog.tsx`）、通知（`toast.tsx`）、設定列（`SettingRow.tsx`）、可收合的表單卡片（`FormCard.tsx`）。外觀沿用同目錄的 CSS；寬度 560px 以下（下拉與日曆另含橫拿的手機）改成從底部滑出的面板。全站不使用原生的 `<select>` 與日期欄位。
- 即時狀態（動作、上下線、事件）由 `GET /api/stream`（Server-Sent Events）推送，全站只開一條，內容寫進 Query 快取；首頁、狀態提醒與狀態頁都跟著它更新。重連時伺服器重送完整狀態；連續 3 次連不上（或瀏覽器沒有 `EventSource`）就改回每 5 秒輪詢，同時繼續嘗試 SSE。磁碟空間不推送，管理員端每分鐘與重連時重抓。

### 頁面

| 頁面 | 內容 | 角色 |
| --- | --- | --- |
| 初始設定 | 沒有任何帳號時出現，建立管理員 | — |
| 登入 | 帳密登入 | — |
| 即時 | 多宮格（`/cameras`）；點進單台（`/cameras/:id`）：HD 切換、看回放、PTZ 控制盤與預置點（相機支援才出現）；之後加快照；管理員另有錄影／偵測開關（尚未做） | 一般使用者 |
| 回放 | 時間軸、日曆、倍速、事件清單、匯出 | 一般使用者 |
| 事件 | 跨攝影機事件列表（依天分組、捲動自動載入），可依攝影機與日期篩選（物件類別篩選等 M4），點一下開回放的那一刻（事件開始前 5 秒）；管理員可刪除已結束的事件 | 一般使用者 |
| 設定 → 攝影機 | 新增／編輯／排序／停用；編輯頁分成基本、連線、錄影、偵測、鏡頭控制、Apple 家庭幾張可收合的卡片，預設全部收合並顯示一行摘要，有錯誤或未儲存的變更會標在卡片上，刪除放在最下面；新增時只有基本、連線（展開）與錄影；測試連線；錄影直連開關；偵測參數與即時分數曲線；遮罩編輯器；物件辨識（模式、類別、信心門檻）；PTZ 偏好（移動方式、預設速度）；HKSV 配對碼；複製 RTSP 網址 | 管理員 |
| 設定 → 錄影與儲存 | 最上面是儲存空間總覽（依攝影機分段的容量條、已刪除攝影機的錄影與清除、大約可保留幾天與目前設定的比較）；下面是保留天數（常用值或自訂）、進階的最低剩餘空間與儲存路徑（改路徑前確認） | 管理員 |
| 設定 → 系統 | 站點名稱、RTSP 轉發開關、HKSV 開關、物件辨識開關、推論裝置與模型 | 管理員 |
| 設定 → 使用者 | 新增、改角色、重設密碼、刪除 | 管理員 |
| 設定 → 狀態 | 一張卡：一句話總結，下面每類問題一列（快照縮圖、攝影機名稱＋狀態膠囊、一句下一步、收合的「可能的原因」、一個動作），同類問題合併成一列（例如「前門、車道 · 沒在錄影」）；下方只列沒有問題的攝影機、儲存空間與系統資源（見「系統資源」）。worker、PID、stderr 等技術細節不直接顯示，收在頁底唯一的「複製診斷資訊」裡 | 管理員 |
| 帳號 | 外觀、改密碼、登入裝置（目前這台置頂）、連接其他 App（API Token） | 一般使用者 |

### 狀態用語

- 攝影機狀態在首頁、設定的攝影機清單與狀態頁共用同一套說法（`web/health.ts`）：錄影中（綠）、不錄影（使用者自己關掉，中性，首頁不標示）、已停用（中性）、沒在錄影（開了錄影卻沒在錄，紅）、連不上（紅）、錄影不穩定（黃）。
- 紅色只代表需要處理；回放的「錄製中」與進行中的事件用平靜的綠色與主色。首頁卡片在有進行中的事件時，名稱前加主色小點、畫面加主色細框，不閃爍。
- 管理員有問題時，首頁頁首出現一條中性底色、帶紅點的提醒（例如「1 台連不上、2 台沒在錄影 · 查看」）連到狀態頁，側欄底部的使用者卡片（手機底部列的「我的」）加上提示點，選單裡的「狀態」顯示問題數；沒有問題時都不顯示。

### 系統資源

- 量測在 `src/metrics/`：每 5 秒取樣一次，保留最近 10 分鐘。容器設了上限（cgroup v2 的 `cpu.max`、`cpuset.cpus.effective` 小於主機，或 `memory.max` 小於主機記憶體）時量容器：CPU 用 `cpu.stat` 的 `usage_usec`，記憶體用 `memory.current − inactive_file`（與 `docker stats` 相同）；沒有上限時量整台主機（`/proc/stat`、`/proc/meminfo` 的 `MemTotal − MemAvailable`；macOS 開發機用 `vm_stat`，近似「活動監視器」的已使用記憶體）。cgroup v1 不讀上限，一律量主機。
- 各類工作的用量：每個 worker 的程序樹（含 ffmpeg 子程序）依類別加總成錄影、動作偵測、物件辨識、即時觀看、影像服務、Apple 家庭、匯出影片、系統本身；錄影、偵測、即時觀看與 HKSV 串流可再分到每台攝影機。CPU 以全部可用核心為 100%，跟整體同一個基準，整體減去這些就是「其他程式」。
- GPU：Nvidia 用 `nvidia-smi --query-gpu`（容器要用 NVIDIA Container Toolkit 啟動，`NVIDIA_DRIVER_CAPABILITIES` 要含 `utility`，預設就有）；Intel 用 `/sys/class/drm` 找卡、用自己程序的 DRM fdinfo（`drm-engine-*`，xe 是 `drm-cycles-*`）算最忙的引擎使用率，不需要 `intel_gpu_top` 要的 perf 權限，但只算得到容器內看得到的程序；容器沒有掛 `/dev/dri` 時視為讀不到。macOS 開發機用 `ioreg` 讀 Apple GPU。讀不到的原因寫進診斷資訊。
- 只有狀態頁開著時（`GET /api/system/metrics?watch=1`，20 秒內有輪詢）才讀各程序與 GPU，其他時候只讀 CPU 與記憶體，維持資源吃緊判斷需要的走勢。狀態頁用輪詢不用 SSE：只有這一頁需要，輪詢本身就告訴後端有人在看，也不會推給每個開著的頁面。
- 狀態頁：CPU、記憶體、每張 GPU 各一格（大數字、量表、10 分鐘走勢）；沒有 GPU 時一句話帶過。「資源花在哪裡」依類別的橫條，可切換處理器／記憶體，展開可看每台攝影機。
- 資源吃緊（`web/health.ts`）：最近 5 分鐘有九成以上的取樣在 90% 以上，CPU 或記憶體各算一個黃色問題，進總結、問題列與首頁提醒；取樣涵蓋不到 5 分鐘時不判斷。

### 導覽

- 主導覽是「攝影機」「事件」「錄影」（手機底部列再加第四格「我的」）。帳號、設定與登出收在側欄底部的使用者卡片選單（手機是底部列第三格「我的」，從底部滑出）；管理員的選單裡「設定」是一組，直接列出各分頁。一般使用者只有帳號與登出。
- 設定頁內保留分頁列；新增、編輯攝影機的子頁不顯示分頁列，只有返回與標題。

### 時區

- 沒有時區設定：前端一律用瀏覽器的時區，HA 用自己的時區。
- 影響所有時間顯示、回放「一天」的邊界、日曆、匯出檔名；需要時區的 API 由前端帶 `tz` 參數。
- 儲存一律 UTC，換時區不影響既有資料。

### 設定生效方式

| 變更 | 影響範圍 |
| --- | --- |
| 攝影機連線資訊 | 重建該台的轉發 path，重啟該台所有 worker |
| 偵測參數、遮罩 | 立即套用在偵測 worker，不重啟 |
| 錄影開關、音訊 | 只重啟該台錄影 worker |
| 儲存路徑 | 重啟所有錄影 worker（舊錄影留在原處，仍可回放） |
| 保留天數、最低剩餘空間 | 不重啟，下一次檢查生效 |
| 物件辨識開關、推論裝置、模型 | 只重啟 detector worker |
| 影像解碼裝置 | 只重啟規劃有變的 detect worker（快照中斷約 2 秒） |
| 單台的物件辨識模式、類別、門檻 | 立即套用，不重啟 |
| HKSV 總開關、單台的 Apple 家庭開關 | 只啟停 homekit worker 或更新它發布的配件 |

單一例外：網頁 port 與 `/data` 位置屬於容器層級，只能在 Docker 設定。

## Home Assistant 整合（HACS）

HA 整合是獨立的 HACS repo `cookienvr-ha`（domain `cookienvr`），用 UI 設定流程加入，狀態靠 SSE 即時推送，影像從 NVR 的 RTSP 轉發讀，不會另外連相機。

### 設定流程

1. 自動發現：NVR 以 mDNS 廣播 `_cookienvr._tcp`（`src/discovery/`，自己實作的最小回應器，不靠套件），TXT 帶 `id`（實例識別碼）、`version`、`api`。HA 的整合頁出現「已發現」，按「新增」。mDNS 出不去（bridge 網路）時改為手動輸入網址。
2. 授權：整合走「授權連結」流程，HA 畫面顯示核准連結與短碼，使用者在 CookieNVR 按「允許」後 HA 自動完成，全程不碰 Token。Token 繼承核准者的角色（要在 HA 切換錄影／偵測開關需用管理員核准）。手動貼 Token 保留為進階欄位。
3. 唯一識別：`/api/info` 的 `instanceId`（第一次啟動產生，存在資料庫 settings 表）。NVR 換 IP 後再次被發現時，HA 更新既有設定的網址而不是新增一台；舊版以網址為識別的設定在啟動時改用 `instanceId`。
4. Token 被撤銷時 HA 進入重新驗證，走同一個授權流程。
5. 每台攝影機自動成為一個 HA 裝置；之後在 NVR 新增或刪除攝影機，HA 會自動同步。

### 每台攝影機的實體

| 實體 | 類型 | 內容 |
| --- | --- | --- |
| `camera.<名稱>` | camera | 快照取自 NVR；stream\_source 為 NVR 的 RTSP 轉發（main） |
| `binary_sensor.<名稱>_motion` | motion | 事件開始／結束 |
| `binary_sensor.<名稱>_<類別>` | occupancy | 進行中的事件含該類別（例如 `_person`）。`config.detect.labels` 每個類別一個（沒開物件辨識或這台不辨識時清單是空的，就沒有）；使用者改了勾選，感應器跟著增減。名稱用 `GET /api/objects/labels` 的中文或英文；類別確認時 SSE 立刻送 event update，感應器不必等事件結束 |
| `binary_sensor.<名稱>_online` | connectivity | 串流是否正常 |
| `switch.<名稱>_recording` | switch | 錄影開關 |
| `switch.<名稱>_detection` | switch | 偵測開關 |
| `select.<名稱>_ptz_preset` | select | 前往預置點（有 PTZ 才有） |
| `button.<名稱>_ptz_*` | button | 上、下、左、右微調（有 PTZ 才有） |
| `image.<名稱>_last_event` | image | 最近一筆事件的縮圖 |
| `sensor.<名稱>_last_event` | timestamp | 最近一筆事件時間 |

NVR 本身另有一個裝置：磁碟用量、錄影總量、正常 worker 數。

### 服務

- `cookienvr.ptz_move`：`pan`、`tilt`、`zoom`（−1 至 1）、`mode`（continuous / relative）、`duration`。
- `cookienvr.ptz_preset`：前往、儲存、刪除預置點。
- `cookienvr.export_clip`：匯出一段影片到 HA 的 media 目錄，可用在通知。

### HA 事件

每筆事件開始與結束都發出 `cookienvr_event`，帶 `camera`、`event_id`、`state`（start / end）、`score`、`labels`（物件類別，沒開物件辨識時為空）、`thumbnail_url`、`playback_url`，可以直接做「有人就推播縮圖」的自動化。

### 連線可靠性

- SSE 斷線自動重連（1 → 30 秒退避）；重連後先拉一次完整狀態，避免漏掉「動作結束」而卡在 on。
- 另每 60 秒輪詢一次全狀態做保險。
- NVR 連不到時所有實體變為 unavailable。

## HomeKit Secure Video

每台攝影機可個別開啟 HKSV，在「家庭」App 裡成為一台支援安全錄影的 HomeKit 攝影機。CookieNVR 負責動作觸發與影像，分析與儲存由 Apple 的家庭中樞和 iCloud 處理。影像原樣轉送不保證符合家庭中樞指定的解析度與碼率，所以這項功能標為實驗性，以實機測試結果為準。

### 前提條件

- 同網路上有家庭中樞（Apple TV、HomePod 或 iPad）。
- iCloud 方案含 HKSV。
- 主碼流為 H.264；H.265 攝影機不能開啟，前端直接灰掉並說明原因。
- 關鍵幀間隔不超過 4 秒；超過時照樣能開，但前端顯示警告（安全錄影的每個 fragment 從關鍵幀開始，最長 4 秒）。
- 容器用 host 網路或 br0 獨立 IP，讓 mDNS 廣播能被找到。

主碼流的編碼、關鍵幀間隔與有沒有音訊由 homekit 模組自己檢查：用 ffprobe 從轉發層讀主碼流 9 秒（`src/homekit/check.ts`），結果依連線設定存在 `<dataDir>/homekit/<攝影機 ID>/check.json`。第一次打開設定頁時等這個檢查（最多 15 秒），之後直接用存下的結果；連線設定改了才重測。

### 開關

- 系統層級：`settings.homekit = { enabled, basePort }`，預設 `{ false, 51826 }`。介面在「設定 → 一般」只放開關；`basePort` 只能經 `PUT /api/settings` 改。
- 單台：`config.homekit = { enabled }`，舊資料沒有就是關閉。由攝影機設定裡「Apple 家庭」區塊的開關經 `POST /api/cameras/:id/homekit` 立即生效，不必按表單的儲存；表單儲存時帶回目前的值。
- 兩者都開、攝影機啟用、檢查沒有判定不符合時才發布配件。沒有任何一台要發布時不啟動 homekit worker，主程序本身從不載入 HAP-NodeJS（只有 worker 會 import）、不開控制連線、不廣播 mDNS。

### 架構

- **homekit worker**（`src/homekit/worker.ts`，經 supervisor，kind `homekit`）：用 HAP-NodeJS 0.14 把每台攝影機發布成獨立配件（不包在 bridge 裡），mDNS 用 ciao。公開的服務：CameraController（即時串流 2 路＋安全錄影）、MotionSensor、Microphone（只送不收，沒有雙向語音）。
- **執行環境：Bun，不加 Node.js。** 實測 HAP-NodeJS 在 Bun 1.4 上只有一個缺口：Bun 的 `node:crypto` 沒有 `chacha20-poly1305`，而 HAP 的配對後加密與 HDS（安全錄影的資料通道）都用它，HAP-NodeJS 載入時就會檢查並中止。worker 在載入 HAP-NodeJS 前先把一份 RFC 8439 的純 TypeScript 實作（Poly1305 用 tweetnacl 的 `lowlevel`）掛進 `node:crypto`（`src/homekit/chacha.ts`，有 RFC 測試向量）。之後配對（SRP、Ed25519、HKDF）、TCP、UDP、ciao 的 multicast 在 Bun 上都正常；實測 1 KiB 的 HAP frame 約 70 MB/s（M 系列 Mac），遠高於一路 HKSV 的 0.5 MB/s。Bun 哪天內建這個 cipher，墊片會自動不安裝。Dockerfile 不用改：`bun install --production` 會裝到 HAP-NodeJS，Debian 的 ffmpeg 有 libopus 與 srtp。
- **配對資料**：每台一個目錄 `<dataDir>/homekit/<攝影機 ID>/`，裡面是 `identity.json`（主程序產生：device id、8 位數配對碼、setup id、port）與 HAP-NodeJS 的 `AccessoryInfo.*.json` 等檔。HAP-NodeJS 只有一個全行程共用的儲存區，worker 換成一個依 key 中的 device id 分到各台目錄的儲存（`src/homekit/hap-storage.ts`）。worker 或主程序重啟後配對仍有效；刪除攝影機時目錄一起刪。
- **配對碼與 QR code**：主程序依 HAP 規則產生配對碼（排除 `000-00-000`、`123-45-678` 等）與 setup URI（`X-HM://` 加 9 碼 base36 與 setup id，和 HAP-NodeJS 的 `setupURI()` 同算法，有對照測試）；QR code 在前端用自寫的編碼器（`web/homekit/qr.ts`，byte mode、ECC M）畫成 SVG。「重設配對」：worker 呼叫 `Accessory.destroy()` 刪掉配對，主程序刪掉整個目錄、產生新的 device id 與配對碼，iOS 會把它當成新配件，舊配對失效。
- **port**：每台一個，從 `basePort` 起取最小沒被其他攝影機用、而且當下綁得起來的 port，記在 `identity.json`；`basePort` 往上調時低於它的會重新分配。
- **主程序 ↔ worker**：主程序在 `127.0.0.1` 開一個隨機 port 的 TCP 控制連線，worker 帶環境變數裡的 token 連上，雙向傳一行一個 JSON（`src/homekit/protocol.ts`，兩邊都在邊界解析）。主程序送配件設定、動作狀態、快照、重設；worker 每 2 秒（以及有變化時）回報各台狀態與它需要的串流 session，這也是心跳。worker 不拿到任何相機帳密或轉發層網址。
- **hksv-stream worker**：即時觀看與安全錄影的 ffmpeg 都由主程序依 worker 回報的 session 宣告成 supervisor worker（`hksv-live:<攝影機>:<session>`、`hksv-record:<攝影機>`），命令列由主程序組（`src/homekit/ffmpeg.ts`）。ffmpeg 一律加 `-progress pipe:1`，supervisor 以 15 秒沒有進度判定卡死。即時觀看的 ffmpeg 一直失敗時，主程序通知 worker 結束那個 HomeKit session。

### 影像來源

| 用途 | 做法 |
| --- | --- |
| 家庭 App 即時觀看 | 有人打開時才啟動 hksv-live：從轉發層讀 main，影像 `-c copy`（`dump_extra` 在每個關鍵幀前補 SPS/PPS），音訊轉 Opus（libopus，取樣率與封包時間照 iPhone 要求），各自用 SRTP（AES_CM_128_HMAC_SHA1_80）送到 iPhone；收到 stop 或 30 秒沒收到 iPhone 的 RTCP 就結束 |
| 快照 | 用 detect worker 的最新快照（`detection.latestJpeg`，640 寬）；尺寸和 HomeKit 要求的不同時，用一個短命的 ffmpeg 從 stdin 縮放並裁成要求的長寬比（5 秒逾時），同一張快照同一尺寸只算一次 |
| HKSV 錄影 | 家庭 App 開啟錄影且中樞選定錄影設定後，常駐 hksv-record：從轉發層讀 main，影像 `-c copy`、音訊轉 AAC-LC（取樣率、碼率、聲道照中樞選定的設定；中樞關閉錄音時不帶音訊），`-movflags frag_keyframe+empty_moov+default_base_moof` 輸出 fMP4 到 worker 在 127.0.0.1 開的 TCP port。每個 fragment 從關鍵幀開始、長度等於一個 GOP（Tapo 是 2 秒）。worker 保留至少 4 秒的 fragment 當預緩衝（`src/homekit/fragments.ts`） |

攝影機設定裡「錄下聲音」關閉時，HomeKit 也不送聲音。

### 觸發流程

1. CookieNVR 的事件開始 → MotionSensor 設為有動作（只有 start／end 會改變，update 不影響）。
2. 家庭中樞決定要錄時開啟錄影串流。worker 送出 init segment、預緩衝內容，再接上即時 fragment；一路串流落後超過 16 MB 就切斷。
3. 事件結束（冷卻時間過後）→ MotionSensor 清除；中樞收到後自行結束串流。
4. 人、動物、車輛、包裹辨識由 Apple 端完成。

家庭 App 裡的「串流／錄影」開關只控制 HomeKit 端，不影響 CookieNVR 自己的 24 小時錄影。雙向語音第一版不做。

### 驗證程度

- 用軟體 HomeKit 用戶端（Python `aiohomekit`）加真的主程序、假相機實測過：mDNS 廣播、用配對碼配對、配件資訊與服務清單、事件帶動 MotionSensor、各尺寸快照、worker 被 SIGKILL 與主程序重啟後配對仍有效、重設配對後舊配對被拒（`IncorrectPairingIdError`）、關閉後送出 mDNS goodbye；即時觀看協商到 iPhone 端該收到的 SRTP 封包（payload type、SSRC 正確），結束後 ffmpeg 停止；開啟錄影設定後 hksv-record 啟動、預緩衝累積到 4 秒。
- 只有 ffprobe 與單元測試：錄影 fMP4 的結構（每個 fragment 從關鍵幀開始、約 2 秒、H.264＋AAC-LC 16 kHz）。
- 沒有 Apple 裝置無法驗證：HDS 資料通道與實際送出錄影給家庭中樞、中樞是否接受 2560×1440 原樣轉送的影像（我們宣告的最大解析度是 1920×1080、level 4.0）、iPhone 是否能解 SRTP 並播出、Opus 音訊、`RecordingAudioActive`（需要 timed write，軟體用戶端不支援）。

參考：[HomeKit Secure Video Open Source Compatibility Guide](https://developer.apple.com/download/files/HomeKit-Secure-Video-Open-Source-Compatibility-Guide.pdf)、[HAP-NodeJS CameraRecordingDelegate](https://developers.homebridge.io/HAP-NodeJS/interfaces/CameraRecordingDelegate.html)、[go2rtc 的 HomeKit 實作](https://github.com/AlexxIT/go2rtc/tree/master/internal/homekit)

## Repo 結構

分成兩個 repo：`cookienvr`（後端＋前端＋Docker，前後端同一個 monorepo）與 `cookienvr-ha`（HACS 整合）。兩邊各自發版，靠 API 版本號對齊。

### `cookienvr`

```
cookienvr/
├─ src/                 後端（Bun + TS）
│  ├─ main.ts
│  ├─ db.ts · settings.ts · auth.ts
│  ├─ http/            API 路由
│  ├─ workers/         worker 監管、記憶體監控
│  ├─ camera/          錄影、偵測、快照
│  ├─ live/            即時串流 worker、fragment 分發、多台串流格式
│  ├─ stream/          SSE 狀態推送
│  ├─ metrics/         CPU、記憶體、GPU 與各類工作用量的量測
│  ├─ restream/        MediaMTX 控制
│  ├─ onvif/           ONVIF 客戶端、PTZ、事件
│  └─ homekit/         HKSV worker
├─ detector/            物件辨識 worker（Python + ONNX Runtime）
├─ web/                 前端（React，Vite 打包到 dist/web）
├─ Dockerfile
├─ docker-compose.example.yml
└─ .github/workflows/   CI、多架構映像推到 ghcr.io
```

### `cookienvr-ha`

```
cookienvr-ha/
├─ custom_components/cookienvr/
│  ├─ manifest.json · __init__.py · config_flow.py
│  ├─ coordinator.py   SSE 與輪詢
│  ├─ camera.py · binary_sensor.py · switch.py · select.py
│  ├─ button.py · image.py · sensor.py · services.yaml
│  └─ translations/    en、zh-Hant
├─ hacs.json
└─ .github/workflows/   hassfest、HACS validation
```

符合 HACS 規則：`hacs.json` 在根目錄、整合放在 `custom_components/<domain>/`、一個 repo 只有一個整合、每次發版建 GitHub Release（[HACS 整合規範](https://hacs.xyz/docs/publish/integration)）。

### 版本對齊

- NVR 的 `/api/info` 回傳 `version` 與 `apiVersion`（整數，只在破壞性變更時 +1）。
- 整合寫死支援的 `apiVersion` 範圍；不符時在 HA 顯示「請更新 CookieNVR」或「請更新整合」的修復提示。
- 兩個 repo 都用 semver；NVR 的 Docker tag 為 `latest`、`x`、`x.y`、`x.y.z`，Nvidia 版加上 `-nvidia` 後綴。`main` 每次 push 另外發 `edge` 與 `edge-nvidia`（尚未發版時用來試部署）。

## HTTP API

前端與 HA 整合共用同一組 JSON API，前綴 `/api`。錯誤一律回 `{ "error": "訊息" }` 與對應 HTTP 狀態碼；時間一律是 UTC 毫秒。

| 方法 | 路徑 | 用途 | 角色 |
| --- | --- | --- | --- |
| GET | `/api/info` | 版本、apiVersion、是否需要初始設定、站點名稱 `siteName`（登入頁、初始設定頁與側欄顯示）、實例識別碼 `instanceId` | 公開 |
| POST | `/api/link` · `/api/link/poll` · `/api/link/proof` | 建立授權連結請求／App 以輪詢憑證查狀態並一次性取回 token／不送出 token 證明持有（見「授權連結」） | 公開（限流） |
| GET / POST | `/api/link/:code` | 核准頁讀取請求／允許或拒絕（`{decision}`；只限瀏覽器 session、同源） | 一般使用者 |
| POST | `/api/auth/setup` | 建立第一位管理員（只在沒有帳號時可用） | 公開 |
| POST | `/api/auth/login` · `/logout` | 登入／登出 | 公開 |
| GET / PUT | `/api/me` | 自己的資料、改密碼 | 一般使用者 |
| GET / POST / DELETE | `/api/me/sessions` · `/api/tokens` | 登入裝置、API Token | 一般使用者 |
| GET / POST / PUT / DELETE | `/api/users` | 使用者管理 | 管理員 |
| GET / PUT | `/api/settings` | 系統設定 | 管理員 |
| GET | `/api/cameras` | 攝影機清單、即時狀態、對外 RTSP 網址（不含密碼；一般使用者不含相機帳密） | 一般使用者 |
| POST / PUT / DELETE | `/api/cameras` · `/:id` | 新增／修改／刪除；錄影與偵測開關也用 PUT；刪除加 `?recordings=delete` 會連同這台的錄影、事件、縮圖一併永久刪除 | 管理員 |
| DELETE | `/api/recordings/orphaned` | 清除不屬於任何現存攝影機的錄影與事件，回傳 `{segments, events, bytes}` | 管理員 |
| POST | `/api/cameras/test` | 測試連線（ffprobe＋ONVIF 探測） | 管理員 |
| GET | `/api/cameras/:id/snapshot.jpg` | 最新快照（detect worker 每秒更新；還沒有畫面等最多 5 秒，連不上 503，停用 404） | 一般使用者 |
| GET | `/api/cameras/:id/motion` | SSE：每張畫面一筆 `sample`（`MotionSampleDto`：分數、是否超過最小面積、狀態、是否有進行中事件），給偵測設定頁 | 管理員 |
| GET | `/api/cameras/:id/live.mp4?quality=` | 即時 fMP4 串流（`sd`／`hd`，預設 `sd`；沒有串流回 404，20 秒內等不到畫面回 503） | 一般使用者 |
| GET | `/api/live?cameras=&quality=` | 多台即時串流包在一條連線（格式見「即時預覽」） | 一般使用者 |
| GET / POST | `/api/cameras/:id/ptz` | 取得能力與預置點／移動、停止、前往預置點 | 一般使用者 |
| POST / DELETE | `/api/cameras/:id/ptz/presets` | 儲存／刪除預置點 | 管理員 |
| GET | `/api/cameras/:id/days?tz=` | 有錄影的日子（`tz` 為 IANA 時區） | 一般使用者 |
| GET | `/api/cameras/:id/recordings?start=&end=` | 時段內的片段清單（含錄製中） | 一般使用者 |
| GET | `/api/segments/:id` | 片段檔，支援 Range | 一般使用者 |
| GET | `/api/events?camera=&start=&end=&before=&limit=&label=` | 事件查詢：沒帶 before 回與 [start, end) 重疊的事件（由舊到新）；帶 before 回開始時間早於它的事件（由新到舊，翻頁用）；`label=person,car` 只回含任一類別的事件 | 一般使用者 |
| GET | `/api/objects` | 物件辨識狀態（實際裝置、退回原因、延遲、速率、丟棄、負載提醒、GPU 使用率）、可選模型、偵測到的裝置、上次測速 | 管理員 |
| POST / DELETE | `/api/objects/benchmark` | 開始測速（`{devices?, seconds?}`，回 202）／取消 | 管理員 |
| GET | `/api/objects/labels` | 目前模型支援的類別：每個 `{key, zh, en}` 與常用類別；前端勾選清單與 HA 感應器名稱用 | 一般使用者 |
| GET | `/api/events/:id` · `/thumb.jpg` | 事件詳情、縮圖 | 一般使用者 |
| DELETE | `/api/events/:id` | 刪除事件與縮圖；進行中的回 409 | 管理員 |
| POST / GET | `/api/exports` | 建立匯出工作（`{cameraId, startMs, endMs, tz}`，回 201 與工作；無錄影 422、超過 2 小時 400、佇列滿 429、磁碟不足 507）／列出所有工作 | 一般使用者 |
| GET / DELETE | `/api/exports/:id` · `/:id/file` | 查進度；下載完成的 MP4（支援 Range）；DELETE 取消排隊中或執行中的工作，已完成的則移除 | 一般使用者 |
| GET | `/api/stream` | SSE：動作、事件、攝影機狀態、worker 狀態 | 一般使用者 |
| GET | `/api/system` | worker 狀態、磁碟、各攝影機用量與最早錄影時間、日誌 | 管理員 |
| GET | `/api/system/metrics?watch=1` | 系統資源：CPU、記憶體（含範圍是容器或主機）、每張 GPU、依類別與攝影機的用量、最近 10 分鐘走勢；`watch=1` 時後端才讀 GPU 與各程序 | 管理員 |
| GET | `/api/system/diagnostics?camera=` | 診斷資訊純文字（`text/plain`）：版本、執行環境、各 worker 狀態與重啟紀錄、輸出尾端、攝影機類型與最近一次測試的碼流資訊、上線與錄影狀態、磁碟、系統資源（量測範圍、各程序用量、每種 GPU 讀取方式成功或失敗的原因）、設定。開頭說明用途，方便貼給 AI；所有密碼、相機帳號、網址帳密、API Token 與 session 一律遮蔽。帶 `camera` 時只含該台與共用的轉發程序 | 管理員 |
| POST | `/api/system/workers/:id/restart` | 手動重啟某個 worker | 管理員 |
| GET / POST | `/api/cameras/:id/homekit` | `HomekitDto`：總開關、這台開關、主碼流檢查、配對碼與 setup URI、是否已配對、發布狀態／`{action: "enable" \| "disable" \| "reset"}`（主碼流不是 H.264 或讀不到時 enable 回 409） | 管理員 |

內部端點 `/internal/rtsp-auth` 只接受 127.0.0.1，供 MediaMTX 驗證 RTSP 連線。

SSE 訊息格式（型別在 `src/api-types.ts` 的 `StreamMessage`）：`event:` 是種類，`data:` 是 JSON。連上時先送 `snapshot`（`cameras` 完整清單、管理員才有的 `workers`、進行中的 `events`）；之後 `cameras`（新增、修改、刪除、排序後的完整清單）、`camera`（單台上線或錄影狀態改變）、`worker`（只送管理員，`state: "stopped"` 表示已移除）、`event`（`{phase: "start" | "update" | "end", event}`；update 只在進行中事件的 labels 改變時送，例如物件辨識確認了新類別）、物件辨識開關改變時重送 `cameras`（對外的 `detect.labels` 會變）、`motion`（`{cameraId, active}`，事件開始為 true、結束為 false）。每 20 秒送一行註解保持連線，積壓超過 1 MB 的用戶端直接斷線，重連後從 `snapshot` 重來。

## 資料模型（SQLite）

單一檔案 `/data/cookienvr.db`，WAL 模式，用 Bun 內建 `bun:sqlite`。schema 用版號化 migration，啟動時自動升級。影片本身不進資料庫，只存索引。

| 表 | 主要欄位 | 說明 |
| --- | --- | --- |
| `users` | id, username, password\_hash, role, created\_at, last\_login\_at | username 不分大小寫唯一 |
| `sessions` | id（token 的 SHA-256）, user\_id, expires\_at, last\_seen\_at, user\_agent, ip |  |
| `api_tokens` | id, user\_id, name, token\_hash, prefix, created\_at, last\_used\_at |  |
| `settings` | key, value（JSON） | 系統設定，沒有的 key 用預設值 |
| `cameras` | id, position, config（JSON）, created\_at, updated\_at | config 含連線、錄影、偵測、遮罩、物件辨識、PTZ、HKSV |
| `segments` | id, camera\_id, path, start\_ms, end\_ms, size | 索引 (camera\_id, start\_ms)；錄製中的片段 end\_ms 為 NULL |
| `events` | id（AUTOINCREMENT，刪掉的 id 不重用，瀏覽器才不會拿到快取的舊縮圖）, camera\_id, source（pixel / onvif / both）, start\_ms, end\_ms, score, labels（JSON）, has\_thumb | 索引 (camera\_id, start\_ms)、(start\_ms)；labels 為類別鍵（物件辨識與 ONVIF 的 person、vehicle、pet，見「物件辨識 → 模型」） |

- 匯出工作佇列只在記憶體；worker 重啟紀錄寫入 `/data/logs/` 的日誌檔，保留 30 天，給狀態頁與排錯。
- 使用者自備的物件辨識模型放在 `/data/models/`。

- 攝影機密碼必須可還原（要組 RTSP 網址），以明文存在 config；API 只回傳給 admin，前端顯示為遮蔽。是否加密列在待決事項。
- 縮圖存在 `/data/thumbs/<event id>.jpg`；HomeKit 配對資料在 `/data/homekit/`。
- 資料庫每天自動備份一份到 `/data/backup/cookienvr-YYYYMMDD.db`，保留最近 7 份。用 SQLite 的 `VACUUM INTO` 取得一致的快照（WAL 模式下直接複製檔案會漏掉 -wal 裡的資料），先寫成 `.tmp`，通過 `quick_check` 才改名。啟動時與之後每小時檢查一次，當天還沒有就備份。

## 穩定性設計

所有重工作都在子程序（worker）裡跑，主程序只做監管、API 與資料庫。每個 worker 有記憶體上限與卡死偵測，出問題只重啟那一個。

### Worker 清單與預設記憶體上限

| Worker | 數量 | 內容 | 預設上限 | 卡死判定 |
| --- | --- | --- | --- | --- |
| restream | 1 | MediaMTX | 512 MB | Control API 10 秒無回應 |
| record | 每台 1 | ffmpeg 切片錄影 | 256 MB | 錄製中的檔案 30 秒沒變大 |
| detect | 每台 1 | ffmpeg 解碼＋ Bun 偵測程序 | 384 MB | 15 秒沒有新 frame |
| detector | 0–1 | 物件辨識推論（開啟才跑，所有攝影機共用；CPU 實測常駐約 180 MB） | 2 GB | 心跳 10 秒無回應，或一張推論超過 10 秒 |
| live | 每台每畫質 0–1 | ffmpeg fMP4 封裝（有人看才跑） | 128 MB | 15 秒沒有新 fragment |
| homekit | 0–1 | HAP-NodeJS（開啟 HKSV 才跑；實測常駐約 80 MB） | 256 MB | 心跳 10 秒無回應 |
| hksv-stream | 每台 0–3 | 家庭 App 觀看（最多 2 路）與 HKSV 錄影（1 路）用的 ffmpeg | 256 MB | 15 秒無進度輸出 |
| export | 0–1 | ffmpeg concat 匯出 | 256 MB | 10 分鐘未完成 |

上限是每類 worker 的固定值，第一版不提供調整；實測不合適就改預設值。detector 的上限只算主記憶體，不含顯示卡記憶體。

### 記憶體監控

1. 主程序每 5 秒量測每個 worker 的常駐記憶體，算上它所有的子孫程序（例如 detect 內的 ffmpeg）。Linux 讀 `/proc/<pid>/status` 的 `VmRSS` 與 `PPid`；沒有 `/proc` 的開發環境（macOS）改用 `ps -A -o pid,ppid,rss`。匯出的 ffmpeg 也在量測範圍內。
2. 連續 3 次（15 秒）超過上限才算過載，避免瞬間尖峰誤殺。
3. 過載 → 先送 SIGTERM，5 秒內沒結束再 SIGKILL → 立刻重啟 → 寫入日誌（原因：memory）並推 SSE。匯出是一次性的工作，過載時改為終止並標為失敗，不重試。

### 重啟策略

- 重啟間隔指數退避：2 → 4 → 8 → … → 最長 30 秒；正常運作 60 秒後歸零。
- 10 分鐘內重啟超過 10 次標為「不穩定」，前端狀態頁與 HA 都看得到，但仍持續重試。
- ffmpeg 的 stderr 保留最後 50 行，重啟時一併記入日誌，方便判斷是相機斷線還是其他原因。
- RTSP 一律用 TCP 與 10 秒 socket timeout，相機斷線時 ffmpeg 會自己退出而不是卡住。

### 主程序自我保護

- 主程序也有上限（預設 512 MB，環境變數 `MAIN_MEMORY_LIMIT_MB`）：每 5 秒檢查，超過一次就先關閉所有 worker 再以非零結束碼退出，由 Docker `restart: unless-stopped` 拉起。
- 主程序結束時保證把所有子程序收乾淨；重新啟動時會清除上次殘留的 ffmpeg。
- 錄影 worker 不依賴主程序的 HTTP 或資料庫，主程序忙碌時不會卡住錄影。
- 磁碟剩餘空間低於最低值時立刻觸發清理，不等 10 分鐘週期。

## 里程碑與待決事項

依風險排序：先把「穩定錄影＋回放」做到可以取代 Frigate，再疊加動作偵測、物件辨識、PTZ、HA、HKSV。每個里程碑結束都能實際部署使用。

1. **M1 錄影核心**：worker 監管（卡死偵測與重啟）、MediaMTX 轉發、Tapo／RTSP 接入、錄影與保留、帳號、設定頁、片段清單與單段播放、單一容器。
   - 驗收：3 台 Tapo 連續錄 7 天無缺片（用片段清單檢查）；拔網路、拔電源後自動恢復；實測 Tapo 同時 RTSP 連線上限。
2. **M2 回放與即時**：即時預覽、回放時間軸、倍速、匯出、worker 記憶體上限。
   - 驗收：桌機瀏覽器 16 倍速、手機 4 倍速播完一天，片段切換沒有黑屏。
3. **M3 動作偵測**：畫面差分、遮罩編輯器、ONVIF 事件、事件頁。
   - 驗收：室外鏡頭一週誤報可接受（標準待定）。
4. **M4 物件辨識**：detector worker、Intel 內顯與 Nvidia 兩種映像、標註與過濾模式、事件類別篩選。
   - 驗收：兩種 GPU 與純 CPU 都能跑；推論程序被強制結束時錄影與動作事件不中斷。
5. **M5 PTZ 與 HA**：ONVIF PTZ、預置點、`cookienvr-ha` 整合上 HACS。
6. **M6 HKSV（實驗性）**：homekit worker、配對、家庭 App 觀看、安全錄影。

### 待決事項

- [x] 錄影預設經轉發層，每台相機每個碼流只佔一條連線。
- [ ] Tapo 每個碼流的連線上限：要在沒有其他軟體連線時重測。若是兩條，「錄影直連相機」可以和轉發層並存；若只有一條，兩者互斥，程式目前沒有處理。
- [ ] 攝影機密碼要不要加密儲存？（金鑰只能放在 `/data`，保護效果有限）
- [ ] 動作偵測誤報的驗收標準。
- [ ] 哪些 Tapo 型號要列為正式支援（需實機測 PTZ 與 ONVIF 事件）。
- [x] 物件辨識的內建模型與授權：內建 YOLOX-Tiny（Apache-2.0）；Ultralytics YOLO 是 AGPL-3.0，只支援使用者自備。
- [x] 物件辨識的映像切法：官方文件明說同一環境只能裝一種 ONNX Runtime 套件，且 CUDA 函式庫很大，維持兩個映像。
- [ ] 物件辨識的 GPU 路徑（Intel 內顯、Nvidia、多張卡）與 amd64 映像只在建置與模擬中驗證過，要在實機跑 `detector-selftest`（步驟見 `detector/README.md`）。
- [ ] Nvidia 舊卡（Maxwell、Pascal）能否用 `onnxruntime-gpu` 1.26 的 CUDA kernel 實際推論，待實機確認。
