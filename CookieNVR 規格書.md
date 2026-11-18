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
- 硬體加速解碼（VAAPI / NVDEC）：子碼流解碼很便宜，GPU 只用於物件辨識
- 多鏡頭同步回放、逐幀播放
- zeroconf 自動發現（HA 整合手動填網址）

## 部署：單一 Docker 容器

整套系統是一個容器、一個 port、一個 volume，在 Unraid 用 Docker Compose 或 Docker 頁面都能直接跑。

- **映像內容**：`oven/bun`（Debian slim）＋ ffmpeg / ffprobe ＋ MediaMTX ＋ 物件辨識用的 Python 與 ONNX Runtime ＋ CookieNVR 原始碼。前端由 Bun 在啟動時打包，不需要另外 build 步驟。
- **映像版本**：`latest` 含 CPU 與 Intel 內顯（OpenVINO）推論；`latest-nvidia` 改含 Nvidia（CUDA）推論。不用物件辨識時兩者沒有差別。
- **平台**：`latest` 支援 `linux/amd64` 與 `linux/arm64`；`latest-nvidia` 只有 `linux/amd64`。
- **GPU（選用，物件辨識用）**：Intel 內顯掛入 `/dev/dri`；Nvidia 需主機裝好 NVIDIA Container Toolkit（Unraid 用 Nvidia Driver 外掛），並以 `--gpus all` 或 `runtime: nvidia` 啟動。沒有 GPU 時用 CPU 推論。
- **網路**：容器需能連到攝影機的 554（RTSP）與 2020（Tapo ONVIF）。不用 HKSV 時 bridge 模式即可；啟用 HKSV 時要用 host 網路，或 Unraid 的 br0 給獨立 IP，因為 HomeKit 靠 mDNS 找裝置。

| 項目 | 值 | 說明 |
| --- | --- | --- |
| Port | `8765` | 網頁、API、瀏覽器串流共用 |
| Port | `8554` | RTSP 轉發，給外部裝置與 HA 接 |
| Port | `51826` 起 | HKSV：每台攝影機一個 HomeKit 配件 port，需 host 網路或 br0 |
| Volume | `/data` | 資料庫、縮圖、預設錄影位置 |
| 選用 Volume | `/recordings` | 想把錄影放在 array、資料庫放在 cache 時使用，路徑在前端指定 |
| `PORT` | 選用 | 覆寫網頁 port |

時區不需要設定：顯示一律用瀏覽器的時區，錄影檔名與資料庫一律存 UTC。

環境變數只管「容器怎麼跑」，不含任何攝影機或功能設定。第一次開啟網頁會進入初始設定，建立管理員帳號。

```yaml
services:
  cookienvr:
    image: ghcr.io/<owner>/cookienvr:latest
    restart: unless-stopped
    ports: ["8765:8765", "8554:8554"]
    # 啟用 HKSV 時改用 host 網路（拿掉 ports）：
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

## 系統架構

一個容器裡有一個輕量主程序和多個獨立 worker。相機只接轉發層，其餘 worker 都從轉發層讀影像；主程序不碰影像資料，只負責監管、API、資料庫與 ONVIF。

- **相機 → 轉發層**：restream worker（MediaMTX）對每台相機的 main、sub 各開一條 RTSP 連線。
- **轉發層 → worker**：record（切片錄影）、detect（差分與快照）、live（瀏覽器用 fMP4）、homekit（HKSV）都從轉發層讀。
- **detect → detector**：開啟物件辨識時，各台 detect worker 在有動作時把畫面送給共用的 detector worker 做 YOLO 推論。
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
2. 按「測試連線」：後端用 ffprobe 讀兩個碼流，回傳編碼、解析度、幀率、音訊格式，並拍一張快照；Tapo 另外測 ONVIF 是否可用、有沒有 PTZ。
3. 測試成功才能儲存；儲存後立刻開始錄影。

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
| 事件保留 | 30 天 | 與事件（含前後緩衝）重疊的片段，以及事件本身與縮圖 |
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

### 畫面差分演算法

1. 3×3 模糊去噪。
2. 與背景模型比較，差值超過「像素門檻」（預設 25/255）算變動像素。
3. 畫面切成 8×8 區塊，區塊內變動像素超過 25% 才算「活動區塊」，濾掉零星雜訊。
4. 分數 = 活動區塊 ÷ 未遮罩區塊；超過「最小面積」（預設 0.5%）算有動作。
5. 背景以滑動平均更新（α = 0.05，約 4 秒吸收靜止物體）。
6. 分數超過 70% 視為光線突變（開燈、切換夜視），重設背景且不觸發。
7. 啟動或重連後的前 10 張不判斷。

### 遮罩

- 在前端的快照上點選畫多邊形，座標存成 0–1 的比例值，換解析度不用重畫。
- 遮罩內的像素不參與計算（例如馬路、樹、時間浮水印）。
- 單台可設多個遮罩；只影響畫面差分，不影響 ONVIF 事件。

### 事件生命週期

1. **開始**：連續 2 張有動作（或收到 ONVIF true）→ 建立事件、存當下快照為縮圖、通知 HA 與 HKSV。
2. **進行中**：記錄最高分數，分數創新高時用當下快照取代縮圖。
3. **結束**：連續「冷卻時間」（預設 10 秒）沒有動作 → 寫入結束時間、通知 HA。
4. 事件最長 10 分鐘，超過就切成新事件，避免一整晚只有一筆。

可調參數（都在前端）：偵測開關、來源、靈敏度（對應像素門檻）、最小面積、冷卻時間、遮罩。前端的偵測設定頁即時顯示分數曲線，方便調整。

## 物件辨識（YOLO，選用）

動作偵測回答「有沒有東西在動」，物件辨識回答「動的是什麼」。YOLO 只在有動作時才跑，用來替事件加上類別（人、車、動物等），或濾掉不是指定類別的誤報。預設關閉；關閉或推論程序當掉時，系統退回純動作偵測，錄影完全不受影響。

### 推論裝置

| 裝置 | 執行方式 | 映像 | 容器需求 |
| --- | --- | --- | --- |
| Intel 內顯 | ONNX Runtime ＋ OpenVINO | `latest` | 掛入 `/dev/dri` |
| Nvidia 顯卡 | ONNX Runtime ＋ CUDA | `latest-nvidia` | NVIDIA Container Toolkit、`runtime: nvidia` |
| CPU | ONNX Runtime | 兩者皆可 | 無 |

- 裝置在「設定 → 系統」選擇，預設「自動」：有可用的 GPU 就用，否則用 CPU。
- GPU 載入模型失敗時退回 CPU，並在狀態頁顯示警告。
- 分成兩個映像是因為 CUDA 函式庫有數 GB，且兩種 ONNX Runtime 套件預期不能並存；能否合併待實測。

### 模型

- 格式為 ONNX，輸入 640×640，類別為 COCO 80 類；前端只列常用類別（人、汽車、機車、腳踏車、貓、狗、鳥）。
- 映像內建 YOLOX（Apache-2.0）。Ultralytics YOLO 是 AGPL-3.0，不內建。
- 使用者可把自己的 ONNX 模型放進 `/data/models/` 並在前端選用，支援 YOLOX 與 Ultralytics YOLO（v8 / 11）的輸出格式。

### 流程

1. 動作觸發（畫面差分或 ONVIF）後，該台的 detect worker 每秒送 2 張 640 寬的畫面給 detector worker，走本機 Unix socket。
2. detector worker 由所有攝影機共用，一次處理一張；排隊超過 1 秒的畫面直接丟掉，不累積延遲。
3. 某類別的信心值超過門檻（預設 0.5）且連續 2 張出現，才寫入事件的 `labels`；縮圖換成信心值最高的那一張。
4. 物件框的中心落在遮罩內就忽略，與動作偵測共用同一組遮罩。

### 模式（單台設定）

| 模式 | 行為 |
| --- | --- |
| 標註（預設） | 事件照常由動作建立，辨識結果只是替事件加上類別 |
| 過濾 | 動作觸發後先等辨識，3 秒內出現勾選的類別才建立事件並通知 HA 與 HKSV，否則丟棄 |

過濾模式下 detector 無法使用時，自動退回標註模式的行為，寧可多報也不漏報。

## 即時預覽

瀏覽器用 MSE 播放 fragmented MP4 串流，影像不轉碼、不需要 WebSocket 或 WebRTC。延遲約等於相機的關鍵幀間隔（Tapo 約 1–2 秒）。

### 串流方式

- 每個碼流有一個 ffmpeg live worker，從轉發層讀取後 `-c copy` 封裝成 fMP4（每個關鍵幀一個 fragment），輸出到 stdout。
- 主程序解析 MP4 box：保留 init segment（ftyp + moov）與最新一個 fragment。
- 新觀看者連上時先收 init＋最新 fragment，立刻有畫面；之後持續收新 fragment。
- 傳輸用一般 HTTP chunked：`GET /api/cameras/:id/live.mp4?quality=sd|hd`，回應標頭 `X-Codec` 帶上從 moov 解出的 codec 字串（例如 `avc1.640028`）。
- 讀太慢的觀看者（積壓超過 4 MB）直接斷線，不拖累其他人。
- 前端定期把播放位置拉回即時邊緣，避免延遲累積。

### 畫質與資源

| 畫質 | 來源 | 何時運作 |
| --- | --- | --- |
| SD（預設） | 子碼流 | 有人在看才啟動，最後一人離開 30 秒後停止 |
| HD | 主碼流 | 同上 |

多宮格頁面一律用 SD；單支攝影機頁面可切 HD。音訊第一版不放進即時預覽。

### 限制

- H.265 是否能播取決於瀏覽器與硬體；不支援時前端顯示提示，不自動轉碼。
- iPhone 沒有 `MediaSource`，前端在 iOS 17.1 以上改用 `ManagedMediaSource`（回放相同），更舊的版本不支援。
- 快照：偵測 worker 同時每秒輸出一張 640 寬的 JPEG，`/snapshot.jpg` 直接回傳記憶體中的最新一張。

## 回放系統

回放是一個以「實際時間」為軸的播放器：拖到哪個時刻就播哪個時刻，跨片段無縫接續，支援 1–16 倍速與時段匯出。

### 畫面配置

- **上方**：攝影機選擇、日期（日曆上標出有錄影的日子）、倍速、匯出。
- **中間**：播放器，按鍵操作：空白鍵播放／暫停、← → 前後 10 秒、`[` `]` 上／下一個事件。
- **下方時間軸**：灰色條是有錄影的時段、空白是缺片、色塊是事件；可縮放 24 小時／6 小時／1 小時／10 分鐘，可拖曳。滑鼠停在事件上顯示縮圖。
- **右側事件清單**：當天事件的縮圖與時間，點一下跳到事件開始前 5 秒。

### 播放器原理

1. 時間軸原點設為當天 00:00（依瀏覽器時區），播放器的 currentTime = 距原點的秒數。
2. 每個片段用 MSE 加入同一個 SourceBuffer。檔名時間只有秒級精度，切點又落在關鍵幀，直接拿來定位會在片段之間留下空隙或重疊，所以連續的片段一律接在前一段的結尾；只有前後相差超過 2 秒（真的缺片）或跳轉後的第一段，才用 `timestampOffset` = 片段開始時間 − 原點重新定位。因此片段之間沒有切換黑屏。
3. 只預先載入播放位置前後的片段；倍速越高預載越多，播過的部分從緩衝區移除以控制記憶體。高倍速是否流暢取決於裝置的解碼能力。
4. 遇到缺片自動跳到下一個有錄影的時刻，時間軸上標出跳過的範圍。
5. 錄製中的片段用 HTTP Range 持續追加新寫入的位元組，回放可以一路播到現在。
6. 跨日：播到 23:59 自動切到隔天。

### 匯出

- 在時間軸上拖曳選取起訖（或從事件一鍵匯出，含前後緩衝）。
- 後端用 ffmpeg concat＋`-c copy` 接成一個一般 MP4（`+faststart`），完成 24 小時後自動刪除暫存檔。切點對齊關鍵幀，可能快上 1–2 秒。
- 單次匯出上限 2 小時，同時只跑一個匯出工作，來不及的排隊。佇列只在記憶體，主程序重啟時清空並刪除暫存檔。
- 一般使用者即可匯出。

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

### 動作偵測與 PTZ 的互動

鏡頭移動中不偵測；停止後 3 秒重設背景再繼續，避免轉鏡頭被當成動作。遮罩是針對畫面位置，鏡頭轉開後會失效，前端要提示這點。

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

### API Token

- 在「帳號 → API Token」建立，名稱如「Home Assistant」「電視牆」；完整 token 只在建立時顯示一次，格式 `cnvr_…`。
- Token 繼承建立者的角色；只想給檢視權限時，用一般使用者帳號建 token。
- 使用方式：`Authorization: Bearer <token>`；快照與串流網址另接受 `?token=`（給無法帶標頭的客戶端）；RTSP 則放在密碼欄。
- 顯示最後使用時間，可隨時撤銷。

## 前端與設定

所有設定都存在 SQLite，從網頁修改後立即生效，只重啟受影響的 worker。前端為繁體中文、RWD，手機也能用。

### 技術

- 原生 TypeScript，不用框架；Bun 的 HTML import 在啟動時打包，沒有另外的 build 步驟。
- Hash 路由（`#/live`、`#/playback`…），後端只需要提供 `/`。
- 即時狀態（動作、上下線、事件）由 `GET /api/stream`（Server-Sent Events）推送。

### 頁面

| 頁面 | 內容 | 角色 |
| --- | --- | --- |
| 初始設定 | 沒有任何帳號時出現，建立管理員 | — |
| 登入 | 帳密登入 | — |
| 即時 | 多宮格；點進單台：HD 切換、PTZ 控制盤、預置點、快照；管理員另有錄影／偵測開關 | 一般使用者 |
| 回放 | 時間軸、日曆、倍速、事件清單、匯出 | 一般使用者 |
| 事件 | 跨攝影機事件列表，可依攝影機、時間、物件類別篩選，點一下開回放；管理員可刪除 | 一般使用者 |
| 設定 → 攝影機 | 新增／編輯／排序／停用；測試連線；錄影直連開關；偵測參數與即時分數曲線；遮罩編輯器；物件辨識（模式、類別、信心門檻）；PTZ；HKSV 配對碼；複製 RTSP 網址 | 管理員 |
| 設定 → 錄影與儲存 | 儲存路徑、保留天數、最低剩餘空間；各攝影機用量 | 管理員 |
| 設定 → 系統 | 站點名稱、RTSP 轉發開關、HKSV 開關、物件辨識開關、推論裝置與模型 | 管理員 |
| 設定 → 使用者 | 新增、改角色、重設密碼、刪除 | 管理員 |
| 設定 → 狀態 | 每個 worker 的狀態、記憶體、重啟次數與原因；磁碟；日誌 | 管理員 |
| 帳號 | 改密碼、登入裝置、API Token | 一般使用者 |

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
| 單台的物件辨識模式、類別、門檻 | 立即套用，不重啟 |

單一例外：網頁 port 與 `/data` 位置屬於容器層級，只能在 Docker 設定。

## Home Assistant 整合（HACS）

HA 整合是獨立的 HACS repo `cookienvr-ha`（domain `cookienvr`），用 UI 設定流程加入，狀態靠 SSE 即時推送，影像從 NVR 的 RTSP 轉發讀，不會另外連相機。

### 設定流程

1. 在 CookieNVR 建一個 API Token（看畫面與控制 PTZ 用一般使用者即可；要在 HA 切換錄影／偵測開關，需用管理員帳號建 Token）。
2. HA → 新增整合 → CookieNVR，填 NVR 網址與 Token；整合會先呼叫 `/api/info` 確認連線與 API 版本。
3. 每台攝影機自動成為一個 HA 裝置；之後在 NVR 新增或刪除攝影機，HA 會自動同步。

### 每台攝影機的實體

| 實體 | 類型 | 內容 |
| --- | --- | --- |
| `camera.<名稱>` | camera | 快照取自 NVR；stream\_source 為 NVR 的 RTSP 轉發（main） |
| `binary_sensor.<名稱>_motion` | motion | 事件開始／結束 |
| `binary_sensor.<名稱>_<類別>` | occupancy | 進行中的事件含該類別（例如 `_person`）；該台有開物件辨識才有，每個勾選的類別一個 |
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
- 關鍵幀間隔不超過 4 秒（測試連線時檢查）。
- 容器用 host 網路或 br0 獨立 IP，讓 mDNS 廣播能被找到。

### 實作

- 使用 HAP-NodeJS（Homebridge 底層的 HomeKit 配件伺服器）。所有 HomeKit 配件跑在一個獨立的 homekit worker，不影響主程序。
- 每台攝影機是獨立配件（不包在 bridge 裡），port 從 51826 起遞增。
- 配對：前端顯示 8 位數配對碼與 QR code；配對資料存在 `/data/homekit/<攝影機 ID>/`。「重設配對」按鈕會清除它。
- 公開的服務：CameraController（串流＋錄影）、MotionSensor。

### 影像來源

| 用途 | 做法 |
| --- | --- |
| 家庭 App 即時觀看 | 有人打開時才啟動 ffmpeg：從轉發層讀 main，影像 `-c copy`、音訊轉 Opus，用 SRTP 送出 |
| 快照 | 用 NVR 記憶體中的最新快照 |
| HKSV 錄影 | 開啟後常駐一個 ffmpeg：從轉發層讀 main，影像 `-c copy`、音訊轉 AAC-LC，輸出 fMP4；worker 保留最近幾秒的 fragment 當預緩衝 |

### 觸發流程

1. CookieNVR 的事件開始 → MotionSensor 設為有動作。
2. 家庭中樞決定要錄時開啟錄影串流。worker 送出 init segment、預緩衝內容，再接上即時 fragment。
3. 事件結束 → MotionSensor 清除；中樞收到後自行結束串流。
4. 人、動物、車輛、包裹辨識由 Apple 端完成。

家庭 App 裡的「串流／錄影」開關只控制 HomeKit 端，不影響 CookieNVR 自己的 24 小時錄影。雙向語音第一版不做。

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
│  ├─ camera/          錄影、偵測、即時串流、fMP4 解析
│  ├─ restream/        MediaMTX 控制
│  ├─ onvif/           ONVIF 客戶端、PTZ、事件
│  └─ homekit/         HKSV worker
├─ detector/            物件辨識 worker（Python + ONNX Runtime）
├─ web/                 前端（原生 TS）
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
- 兩個 repo 都用 semver；NVR 的 Docker tag 為 `latest`、`x`、`x.y`、`x.y.z`，Nvidia 版加上 `-nvidia` 後綴。

## HTTP API

前端與 HA 整合共用同一組 JSON API，前綴 `/api`。錯誤一律回 `{ "error": "訊息" }` 與對應 HTTP 狀態碼；時間一律是 UTC 毫秒。

| 方法 | 路徑 | 用途 | 角色 |
| --- | --- | --- | --- |
| GET | `/api/info` | 版本、apiVersion、是否需要初始設定 | 公開 |
| POST | `/api/auth/setup` | 建立第一位管理員（只在沒有帳號時可用） | 公開 |
| POST | `/api/auth/login` · `/logout` | 登入／登出 | 公開 |
| GET / PUT | `/api/me` | 自己的資料、改密碼 | 一般使用者 |
| GET / POST / DELETE | `/api/me/sessions` · `/api/tokens` | 登入裝置、API Token | 一般使用者 |
| GET / POST / PUT / DELETE | `/api/users` | 使用者管理 | 管理員 |
| GET / PUT | `/api/settings` | 系統設定 | 管理員 |
| GET | `/api/cameras` | 攝影機清單、即時狀態、對外 RTSP 網址（不含密碼；一般使用者不含相機帳密） | 一般使用者 |
| POST / PUT / DELETE | `/api/cameras` · `/:id` | 新增／修改／刪除；錄影與偵測開關也用 PUT | 管理員 |
| POST | `/api/cameras/test` | 測試連線（ffprobe＋ONVIF 探測） | 管理員 |
| GET | `/api/cameras/:id/snapshot.jpg` | 最新快照 | 一般使用者 |
| GET | `/api/cameras/:id/live.mp4?quality=` | 即時 fMP4 串流 | 一般使用者 |
| GET / POST | `/api/cameras/:id/ptz` | 取得能力與預置點／移動、停止、前往預置點 | 一般使用者 |
| POST / DELETE | `/api/cameras/:id/ptz/presets` | 儲存／刪除預置點 | 管理員 |
| GET | `/api/cameras/:id/days?tz=` | 有錄影的日子（`tz` 為 IANA 時區） | 一般使用者 |
| GET | `/api/cameras/:id/recordings?start=&end=` | 時段內的片段清單（含錄製中） | 一般使用者 |
| GET | `/api/segments/:id` | 片段檔，支援 Range | 一般使用者 |
| GET | `/api/events?camera=&label=&start=&end=&before=&limit=` | 事件查詢 | 一般使用者 |
| GET | `/api/events/:id` · `/thumb.jpg` | 事件詳情、縮圖 | 一般使用者 |
| DELETE | `/api/events/:id` | 刪除事件 | 管理員 |
| POST / GET | `/api/exports` · `/:id` | 建立匯出工作、查進度、下載 | 一般使用者 |
| GET | `/api/stream` | SSE：動作、事件、攝影機狀態、worker 狀態 | 一般使用者 |
| GET | `/api/system` | worker 狀態、磁碟、日誌 | 管理員 |
| POST | `/api/system/workers/:id/restart` | 手動重啟某個 worker | 管理員 |
| GET / POST | `/api/cameras/:id/homekit` | 配對碼、配對狀態／重設配對 | 管理員 |

內部端點 `/internal/rtsp-auth` 只接受 127.0.0.1，供 MediaMTX 驗證 RTSP 連線。

SSE 訊息格式：`event: motion` / `event` / `camera` / `worker`，`data` 為 JSON；連上時先送一筆 `snapshot`（完整狀態）。

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
| `events` | id, camera\_id, source（pixel / onvif）, start\_ms, end\_ms, score, labels（JSON）, has\_thumb | 索引 (camera\_id, start\_ms)；labels 為物件類別與最高信心值 |

- 匯出工作佇列只在記憶體；worker 重啟紀錄寫入 `/data/logs/` 的日誌檔，保留 30 天，給狀態頁與排錯。
- 使用者自備的物件辨識模型放在 `/data/models/`。

- 攝影機密碼必須可還原（要組 RTSP 網址），以明文存在 config；API 只回傳給 admin，前端顯示為遮蔽。是否加密列在待決事項。
- 縮圖存在 `/data/thumbs/<event id>.jpg`；HomeKit 配對資料在 `/data/homekit/`。
- 資料庫每天自動備份一份到 `/data/backup/`，保留 7 份。

## 穩定性設計

所有重工作都在子程序（worker）裡跑，主程序只做監管、API 與資料庫。每個 worker 有記憶體上限與卡死偵測，出問題只重啟那一個。

### Worker 清單與預設記憶體上限

| Worker | 數量 | 內容 | 預設上限 | 卡死判定 |
| --- | --- | --- | --- | --- |
| restream | 1 | MediaMTX | 512 MB | Control API 10 秒無回應 |
| record | 每台 1 | ffmpeg 切片錄影 | 256 MB | 錄製中的檔案 30 秒沒變大 |
| detect | 每台 1 | ffmpeg 解碼＋ Bun 偵測程序 | 384 MB | 15 秒沒有新 frame |
| detector | 0–1 | 物件辨識推論（開啟才跑，所有攝影機共用） | 2 GB | 心跳 10 秒無回應 |
| live | 每台每畫質 0–1 | ffmpeg fMP4 封裝（有人看才跑） | 128 MB | 15 秒沒有新 fragment |
| homekit | 0–1 | HAP-NodeJS（開啟 HKSV 才跑） | 256 MB | 心跳 10 秒無回應 |
| hksv-stream | 每台 0–2 | 家庭 App 觀看與 HKSV 錄影用的 ffmpeg | 256 MB | 15 秒無輸出 |
| export | 0–1 | ffmpeg concat 匯出 | 256 MB | 10 分鐘未完成 |

上限是每類 worker 的固定值，第一版不提供調整；實測不合適就改預設值。detector 的上限只算主記憶體，不含顯示卡記憶體。

### 記憶體監控

1. 主程序每 5 秒讀 `/proc/<pid>/status` 的 `VmRSS`，算上該 worker 的子程序（例如 detect 內的 ffmpeg）。
2. 連續 3 次（15 秒）超過上限才算過載，避免瞬間尖峰誤殺。
3. 過載 → 先送 SIGTERM，5 秒內沒結束再 SIGKILL → 立刻重啟 → 寫入日誌（原因：memory）並推 SSE。

### 重啟策略

- 重啟間隔指數退避：2 → 4 → 8 → … → 最長 30 秒；正常運作 60 秒後歸零。
- 10 分鐘內重啟超過 10 次標為「不穩定」，前端狀態頁與 HA 都看得到，但仍持續重試。
- ffmpeg 的 stderr 保留最後 50 行，重啟時一併記入日誌，方便判斷是相機斷線還是其他原因。
- RTSP 一律用 TCP 與 10 秒 socket timeout，相機斷線時 ffmpeg 會自己退出而不是卡住。

### 主程序自我保護

- 主程序也有上限（預設 512 MB）：超過時先關閉所有 worker 再退出，由 Docker `restart: unless-stopped` 拉起。
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
- [ ] 物件辨識的內建模型與授權：Ultralytics YOLO 是 AGPL-3.0，內建會影響整個專案的授權；目前規格寫內建 YOLOX（Apache-2.0）。
- [ ] 物件辨識的映像切法：Intel 與 Nvidia 的 ONNX Runtime 套件能否放進同一個映像，待實測。
