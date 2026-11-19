import type { OnvifErrorKind } from "./onvif/errors.ts";
import type { CameraConfig, CameraId, DeviceRef, PtzMode, Role, Settings, WorkerStatus } from "./types.ts";

export const API_VERSION = 1;

export interface ErrorDto {
  error: string;
}

export interface InfoDto {
  version: string;
  apiVersion: number;
  needsSetup: boolean;
  /** 顯示在登入頁、初始設定頁與側欄的站點名稱 */
  siteName: string;
  /** 第一次啟動時產生的穩定識別碼；HA 用它認出同一台 NVR（換 IP 也一樣） */
  instanceId: string;
}

export interface MeDto {
  id: number;
  username: string;
  role: Role;
}

export interface UserDto extends MeDto {
  createdAt: number;
  lastLoginAt: number | null;
}

export interface SessionDto {
  id: string;
  current: boolean;
  userAgent: string;
  ip: string;
  lastSeenAt: number;
}

export interface TokenDto {
  id: number;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** 只在建立當下回傳一次完整 token */
export interface CreatedTokenDto extends TokenDto {
  token: string;
}

/** 授權連結請求（免 token 連接其他 App）的狀態；只存在記憶體 */
export type LinkStatus = "pending" | "approved" | "denied" | "claimed" | "expired";

/** POST /api/link 的回應：code 給人對照，pollSecret 只有發起的 App 知道 */
export interface LinkCreatedDto {
  code: string;
  approveUrl: string;
  pollSecret: string;
  expiresAt: number;
  /** 幾秒後過期；兩端時鐘可能不同步，用這個而不是 expiresAt 倒數（RFC 8628 的 expires_in） */
  expiresIn: number;
  /** 建議的輪詢間隔（秒） */
  interval: number;
}

/** POST /api/link/poll 的回應；approved 只會回一次，之後是 claimed */
export type LinkPollDto =
  | { status: "pending" | "denied" | "claimed" | "expired" }
  | { status: "approved"; token: string; username: string; role: Role };

/** 核准頁看到的請求內容 */
export interface LinkRequestDto {
  code: string;
  app: string;
  ip: string;
  createdAt: number;
  expiresAt: number;
  /** 剩幾秒過期，前端用它倒數 */
  expiresIn: number;
  status: LinkStatus;
}

/** POST /api/link/proof：App 不送出 token，確認新位址上的確實是發 token 的那台 NVR */
export interface LinkProofDto {
  proof: string;
}

export interface CameraDto {
  id: CameraId;
  position: number;
  /** 一般使用者拿到的 config 會把所有密碼換成空字串，RTSP 網址中的帳密也會移除 */
  config: CameraConfig;
  online: boolean;
  recording: boolean;
  /** 對外 RTSP 網址，不含帳密 */
  rtsp: { main: string; sub: string | null };
}

export interface StreamInfo {
  videoCodec: string;
  width: number;
  height: number;
  fps: number;
  audioCodec: string | null;
}

/**
 * 測試連線時順便探測 ONVIF 的結果。連不上不算測試失敗，主碼流成功就是 `ok: true`。
 * - unconfigured：通用 RTSP 沒填 ONVIF
 * - available：連上了；ptz 說明有沒有鏡頭控制
 * - unavailable：連不上、逾時、帳密錯誤或相機回錯；message 是給使用者看的中文
 */
export type OnvifProbeDto =
  | { state: "unconfigured" }
  | { state: "available"; ptz: boolean; zoom: boolean; maxPresets: number | null }
  | { state: "unavailable"; kind: OnvifErrorKind; message: string };

export type ProbeResult =
  | { ok: true; main: StreamInfo; sub: StreamInfo | null; snapshotJpegBase64: string | null; onvif: OnvifProbeDto }
  | { ok: false; error: string };

export interface PtzPresetDto {
  token: string;
  name: string;
}

/**
 * GET /api/cameras/:id/ptz。不支援不是錯誤：
 * - no-onvif：這台沒有設定 ONVIF（通用 RTSP 沒填）
 * - no-ptz：ONVIF 連得上，但相機沒有 PTZ
 * 連不上、逾時、帳密錯誤、相機回錯則是 HTTP 錯誤（503、504、502），訊息已是中文。
 */
export type PtzDto =
  | { supported: false; reason: "no-onvif" | "no-ptz" }
  | {
      supported: true;
      continuous: boolean;
      relative: boolean;
      zoom: boolean;
      /** 相機沒回報上限時為 null */
      maxPresets: number | null;
      presets: PtzPresetDto[];
      /** 這台攝影機設定的偏好；請求沒帶 mode、speed 時後端用它們 */
      prefs: { mode: PtzMode; speed: number };
    };

/**
 * POST /api/cameras/:id/ptz。
 * - move：pan、tilt、zoom 各 -1 到 1（至少一軸不為 0），speed 0.1 到 1.0；mode 沒帶用攝影機偏好。
 *   持續移動要每 500 ms 重送，後端 1.5 秒沒收到新的移動就自動停止。
 * - stop：停止所有軸。
 * - preset：前往預置點。
 */
export type PtzCommandDto =
  | { action: "move"; pan?: number; tilt?: number; zoom?: number; speed?: number; mode?: PtzMode }
  | { action: "stop" }
  | { action: "preset"; token: string; speed?: number };

/** move 的回應：實際使用的移動方式（自動模式會因相機而變）。stop 與 preset 回 204 */
export interface PtzMoveResultDto {
  mode: "continuous" | "relative";
}

/** POST /api/cameras/:id/ptz/presets（管理員）。沒帶 token 是新增，帶了是覆寫該預置點 */
export interface PtzSavePresetDto {
  name: string;
  token?: string;
}

/** DELETE /api/cameras/:id/ptz/presets（管理員）的請求內容 */
export interface PtzRemovePresetDto {
  token: string;
}

export interface PtzPresetsDto {
  presets: PtzPresetDto[];
}

export interface PtzPresetSavedDto extends PtzPresetsDto {
  /** 剛儲存的預置點 */
  token: string;
}

export interface SegmentDto {
  id: number;
  cameraId: CameraId;
  startMs: number;
  endMs: number | null;
  size: number;
}

export interface SystemDto {
  workers: WorkerStatus[];
  disk: { path: string; totalBytes: number; freeBytes: number };
  /** oldestMs 是這台攝影機最早一段錄影的開始時間，給「大約可保留幾天」的估算用 */
  usage: { cameraId: CameraId; bytes: number; oldestMs: number | null }[];
  logs: string[];
  /** 影像解碼用哪張卡；狀態頁用 warning 顯示退回 CPU 的提醒 */
  decode: DecodeStatusDto;
}

export type VideoCodecName = "h264" | "hevc";
export type VideoDeviceKind = "intel" | "nvidia" | "apple";

/** 一項試跑：ok 附耗時（毫秒，含啟動 ffmpeg）；失敗附白話原因與 ffmpeg 的訊息（只放診斷資訊） */
export type CodecCheckDto = { ok: true; ms: number } | { ok: false; reason: string; detail: string };

/**
 * 一張可做影片硬體解碼／編碼的顯示卡。id 和物件辨識的推論裝置同一套（intel:GPU.0、nvidia:GPU-<uuid>），
 * 存進 `Settings.devices.decode`；pci 對應系統資源 `GpuDto.id` 的 `<vendor>:<PCI 位址>`。
 * apple:0（VideoToolbox）只會出現在 macOS 開發機。
 */
export interface VideoDeviceDto {
  id: string;
  kind: VideoDeviceKind;
  name: string;
  pci: string | null;
  decode: Record<VideoCodecName, CodecCheckDto>;
  /** 目前沒有工作會編碼影片（錄影、預覽、匯出、HKSV 都是直接複製），只供參考與診斷 */
  encode: Record<VideoCodecName, CodecCheckDto>;
}

/** 一台 detect worker 的解碼方式：device 是裝置識別字，null 是 CPU；confirmed = 第一張畫面已由這張卡解出 */
export interface CameraDecodeDto {
  cameraId: CameraId;
  device: string | null;
  confirmed: boolean;
  fallback: { reason: string; detail: string } | null;
}

export interface DecodeStatusDto {
  /** `Settings.devices.decode` */
  requested: DeviceRef;
  cameras: CameraDecodeDto[];
  /** 給狀態頁的一句話（例如「客廳改用處理器解碼：…」）；沒有退回時為 null */
  warning: string | null;
}

/** GET /api/video-devices（管理員）；`?refresh=1` 重新試跑。第一次請求會等試跑完成（通常幾秒） */
export interface VideoDevicesDto {
  /** 試跑的時間；ffmpeg 是 `ffmpeg -version` 的第一行 */
  probedAt: number;
  ffmpeg: string;
  devices: VideoDeviceDto[];
  decode: DecodeStatusDto;
}

/**
 * 量的是哪個範圍：container = 容器設了上限（cgroup v2 的 cpu.max、cpuset 或 memory.max），用量與上限都是容器的；
 * host = 沒有上限（或不在容器裡），用量與總量都是整台主機的。
 */
export type ResourceScope = "container" | "host";

export type GpuVendor = "nvidia" | "intel" | "apple";

export interface GpuDto {
  /** 穩定的識別：nvidia:<PCI 位址>、intel:<PCI 位址>、apple:<序號> */
  id: string;
  vendor: GpuVendor;
  /** Nvidia 是 nvidia-smi 的型號；Intel 只有「Intel 內顯」這類概稱 */
  name: string;
  /** 最忙的引擎的使用率，0 到 100；讀不到或還沒有第二次取樣時是 null */
  utilPct: number | null;
  /** 顯示記憶體；內顯與 Apple 共用系統記憶體，所以是 null */
  memory: { usedBytes: number; totalBytes: number } | null;
  temperatureC: number | null;
  /** 有數值讀不到時給使用者看的一句話，例如「這張顯示卡不提供溫度」 */
  note: string | null;
  /** 其他模組補充的資訊（例如物件辨識的推論速率），一行一筆 */
  extras: { label: string; value: string }[];
}

/** 沒有任何 GPU 時的原因：none = 沒有偵測到顯示卡；unreadable = 有顯示卡但讀不到（原因在診斷資訊） */
export type GpuMissing = "none" | "unreadable";

export type UsageCategory = "record" | "detect" | "detector" | "live" | "restream" | "homekit" | "export" | "system";

/** cpuPct 跟 MetricsDto.cpu.pct 同一個基準（全部可用核心 = 100），各類別加總加上 other 約等於整體 */
export interface UsageDto {
  category: UsageCategory;
  cpuPct: number;
  memBytes: number;
  /** 能分到單一攝影機的部分；影像服務、Apple 家庭總程序與系統本身是共用的，沒有這一項 */
  cameras: { cameraId: CameraId; cpuPct: number; memBytes: number }[];
}

export interface MetricsPointDto {
  at: number;
  cpuPct: number | null;
  memPct: number;
  /** GPU id → 使用率；沒有人看狀態頁時不讀 GPU，這一筆就是空的 */
  gpus: Record<string, number | null>;
}

/** GET /api/system/metrics（管理員）。帶 watch=1 表示狀態頁開著，後端才會讀 GPU 與各程序的用量 */
export interface MetricsDto {
  at: number;
  intervalMs: number;
  cpu: { pct: number | null; cores: number; scope: ResourceScope };
  memory: { usedBytes: number; totalBytes: number; scope: ResourceScope };
  gpus: GpuDto[];
  /** gpus 是空的時候才有值；還沒讀過 GPU 時是 null */
  gpuMissing: GpuMissing | null;
  /** 依類別的用量，只在有人看狀態頁時計算；還沒算出來時是 null */
  usage: UsageDto[] | null;
  /** 不屬於 CookieNVR 程序的部分：scope 是 host 時是同一台主機上的其他程式，記憶體另含系統快取 */
  other: { cpuPct: number; memBytes: number } | null;
  /** 最近 10 分鐘，舊的在前 */
  history: MetricsPointDto[];
}

/** 清除錄影的結果；bytes 是釋放的空間 */
export interface PurgeDto {
  segments: number;
  events: number;
  bytes: number;
}

export type SettingsDto = Settings;

/** pixel = 畫面差分；onvif = 相機事件；both = 同一段時間兩個來源都觸發，合併成一筆 */
export type EventSourceKind = "pixel" | "onvif" | "both";

/**
 * GET /api/events?camera=&start=&end=&before=&limit=
 * - 沒帶 before：與 [start, end) 重疊的事件（進行中的也算），依開始時間由舊到新。
 * - 帶 before（毫秒）：開始時間早於 before 的事件，由新到舊；事件頁用最後一筆的 startMs 往下翻頁。
 * - label=person,car：只回含任一類別的事件。
 * labels：類別鍵（小寫英文、數字、底線，與 `config.detect.labels`、`GET /api/objects/labels` 同一套）。
 *   物件辨識確認過的類別（同一類別連續 2 張超過門檻），例如 person、car、dog；自備模型的類別照原名轉成鍵。
 *   相機事件（ONVIF）的人形、車輛、寵物寫成 person、vehicle、pet：person 與物件辨識的 person 合併，
 *   vehicle、pet 是相機自己的分類，和物件辨識的 car、dog 等各自獨立。
 */
export interface EventDto {
  id: number;
  cameraId: CameraId;
  source: EventSourceKind;
  startMs: number;
  /** null = 進行中 */
  endMs: number | null;
  score: number;
  labels: string[];
  hasThumb: boolean;
}

export type ExportState = "queued" | "running" | "done" | "failed";

export interface ExportRequestDto {
  cameraId: CameraId;
  startMs: number;
  endMs: number;
  /** IANA 時區，用來產生檔名裡的當地時間；沒帶就用 UTC */
  tz?: string;
}

export interface ExportDto {
  id: string;
  cameraId: CameraId;
  cameraName: string;
  startMs: number;
  /** 實際匯出的結束時間；要求的結束時間在未來時會收到現在 */
  endMs: number;
  /** 範圍內實際有錄影的長度，缺片不算 */
  durationMs: number;
  estimatedBytes: number;
  /** 範圍包含錄製中的片段，匯出到目前已寫入的部分 */
  includesRecording: boolean;
  state: ExportState;
  /** 0 到 1 */
  progress: number;
  /** 排隊中時，前面還有幾個；其他狀態為 null */
  ahead: number | null;
  sizeBytes: number | null;
  error: string | null;
  fileName: string;
  createdAt: number;
  finishedAt: number | null;
  /** 完成後自動刪除的時間 */
  expiresAt: number | null;
}

/**
 * 一張畫面的偵測狀態：
 * - ok：有計算分數
 * - warmup：剛啟動、重連或鏡頭剛停下，背景還在建立（前 10 張不判斷）
 * - paused：鏡頭正在移動
 * - off：這台沒有用畫面差分（偵測關閉或只用相機事件），只解碼供快照
 * - light：整體亮度突變（開燈、切換夜視），已重設背景，不觸發
 */
export type DetectFrameState = "ok" | "warmup" | "paused" | "off" | "light";

/** GET /api/cameras/:id/motion（SSE，管理員）：每張畫面一筆 `sample` 訊息，約每秒 5 筆 */
export interface MotionSampleDto {
  at: number;
  /** 活動區塊占未遮罩區塊的比例，0 到 1；state 不是 ok 時為 null */
  score: number | null;
  /** 超過最小面積 */
  motion: boolean;
  state: DetectFrameState;
  /** 這台目前有進行中的事件 */
  eventActive: boolean;
}

/** `GET /api/stream` 連上時的第一筆訊息，也是斷線重連後的完整狀態 */
export interface StreamSnapshotDto {
  cameras: CameraDto[];
  /** 只有管理員收得到；一般使用者是 null */
  workers: WorkerStatus[] | null;
  /** 進行中的事件 */
  events: EventDto[];
}

/**
 * SSE 訊息：`event:` 是 type，`data:` 是 JSON 的 data。
 * cameras 在新增、修改、刪除、排序後送完整清單；camera 在上線或錄影狀態改變時送單台。
 * event 的 phase：start（建立）、update（進行中的事件 labels 改變，例如物件辨識確認了新類別，立刻推送）、end（結束）。
 * 分數創新高、換縮圖不推 update。
 */
export type StreamMessage =
  | { type: "snapshot"; data: StreamSnapshotDto }
  | { type: "cameras"; data: CameraDto[] }
  | { type: "camera"; data: CameraDto }
  | { type: "worker"; data: WorkerStatus }
  | { type: "event"; data: { phase: "start" | "update" | "end"; event: EventDto } }
  | { type: "motion"; data: { cameraId: CameraId; active: boolean } };

/** 主碼流是否符合 HKSV 的前提；unknown = 還沒讀到畫面（離線或檢查中斷） */
export type HomekitCheckDto =
  | { state: "ok"; keyframeIntervalSec: number | null; warning: "keyframe-interval" | null }
  | { state: "blocked"; reason: "not-h264" | "no-video"; videoCodec: string | null }
  | { state: "unknown" };

/**
 * `GET /api/cameras/:id/homekit`。status：off = 這台沒開或總開關關閉；starting = 等 homekit worker 發布；
 * ready = 已在區網廣播；failed = 發布失敗（原因在診斷資訊）。
 */
export interface HomekitDto {
  systemEnabled: boolean;
  enabled: boolean;
  check: HomekitCheckDto;
  /** 開啟後才有 */
  pairing: { code: string; setupUri: string; paired: boolean } | null;
  status: "off" | "starting" | "ready" | "failed";
}

export type HomekitActionDto = { action: "enable" | "disable" | "reset" };
/** 推論裝置的類別 */
export type InferenceDeviceKind = "cpu" | "intel" | "nvidia";

/** detector 偵測到的一個推論裝置；id 是穩定的識別字，存進 `Settings.devices` */
export interface InferenceDeviceDto {
  id: string;
  kind: InferenceDeviceKind;
  /** 型號，例如「Intel(R) UHD Graphics 630」「NVIDIA GeForce GTX 1650」 */
  name: string;
  /** PCI 位址，對應系統資源 `GpuDto.id` 的 `<vendor>:<PCI 位址>`；拿不到為 null（CPU、多顆 Intel 內顯） */
  pci: string | null;
}

/** Nvidia 卡的使用率與顯示記憶體（每 10 秒更新）；其他裝置拿不到為 null */
export interface GpuUsageDto {
  utilPercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
}

/**
 * 物件辨識 worker 的狀態：
 * - off：系統設定沒開
 * - starting：程序剛啟動或重啟中，還沒連上
 * - loading：載入模型中（GPU 第一次編譯可能要數十秒）
 * - ready：可以辨識；device 是實際使用的裝置，fallback 是指定的裝置不能用或不見了、改用別的裝置的原因
 * - error：模型不能用（找不到、不是 ONNX、輸出格式看不懂），error 是給使用者看的中文
 */
export interface ObjectsStatusDto {
  state: "off" | "starting" | "loading" | "ready" | "error";
  /** 設定的裝置（auto、cpu 或識別字） */
  requested: DeviceRef;
  device: InferenceDeviceDto | null;
  fallback: { reason: string; detail: string } | null;
  error: string | null;
  /** 選用的模型；format 與 input 在載入後才知道 */
  model: { id: string; name: string; format: string | null; input: [number, number] | null };
  /** 最近 50 張的推論時間（毫秒，含 JPEG 解碼與前後處理）；還沒推論過為 null */
  latencyMs: { last: number; avg: number; max: number } | null;
  /** 主程序啟動以來推論的張數與排隊超過 1 秒被丟掉的張數 */
  processed: number;
  dropped: number;
  /** 最近 60 秒平均每秒實際推論幾張 */
  rateFps: number;
  /** 最近 5 分鐘被丟掉的比例；畫面太少時為 null */
  dropRatio: number | null;
  /** 測速中暫停辨識（期間事件照常由動作建立，過濾模式暫時改成標註） */
  paused: "benchmark" | null;
  /** 負載過高的提醒（一般人看得懂的中文）；沒有問題為 null */
  warning: string | null;
  gpu: GpuUsageDto | null;
}

/** 一個裝置的測速結果；fps 是推論程序一張接一張做時每秒能做幾張（含解碼與前後處理），cameras 是換算結果 */
export interface BenchmarkResultDto {
  device: string;
  kind: InferenceDeviceKind;
  name: string;
  ok: boolean;
  error?: string;
  loadMs?: number;
  frames?: number;
  fps?: number;
  msMean?: number;
  msP90?: number;
  /** 同時有動作、每台每秒辨識 perCameraFps 次時，大約可以撐幾台（已扣掉餘裕，見 src/objects/capacity.ts） */
  cameras?: number;
}

/** 測速：管理員手動啟動；結果存在 `<dataDir>/detector-benchmark.json` */
export interface BenchmarkDto {
  state: "running" | "done" | "cancelled" | "failed";
  startedAt: number;
  finishedAt: number | null;
  /** 測速當時的模型 id 與每台每秒辨識次數 */
  model: string;
  perCameraFps: number;
  progress: { device: string; index: number; total: number; fraction: number } | null;
  results: BenchmarkResultDto[];
  error: string | null;
  /** 換了模型、或測過的裝置都不在了：結果可能不準 */
  stale: boolean;
  /** 對照目前設定（實際使用的裝置、目前的辨識頻率、開了物件辨識的攝影機數）：夠不夠用 */
  verdict: { device: string; supported: number; cameras: number; state: "enough" | "partial" } | null;
}

/** 可選用的模型：內建一個，加上 <dataDir>/models/ 裡的 .onnx */
export interface ObjectModelDto {
  id: string;
  name: string;
  builtin: boolean;
  sizeBytes: number | null;
}

/** GET /api/objects（管理員） */
export interface ObjectsDto {
  status: ObjectsStatusDto;
  models: ObjectModelDto[];
  /** 使用者模型要放的資料夾（容器內路徑） */
  modelsDir: string;
  /** 偵測到的推論裝置（含 CPU）；detector 沒在跑時會另外執行一次偵測（結果快取 5 分鐘） */
  devices: InferenceDeviceDto[];
  /** 某一類裝置不能用的原因（例如映像沒有 Nvidia 元件、沒掛 /dev/dri）；可用為 null */
  unavailable: { intel: string | null; nvidia: string | null };
  benchmark: BenchmarkDto | null;
}

/** 一個物件類別：key 是設定與事件用的鍵，zh 是中文（沒有翻譯時是原名），en 是模型裡的原名 */
export interface ObjectLabelDto {
  key: string;
  zh: string;
  en: string;
}

/**
 * GET /api/objects/labels（一般使用者）：目前模型支援的類別。前端的勾選清單與 HA 的感應器名稱都用它。
 * 內建模型是 COCO 80 類（沒有「包裹」）；自備模型的類別照原名轉成鍵傳遞。
 * known = false 代表自備模型還沒載入過，清單暫時是 COCO 80 類。
 */
export interface ObjectLabelsDto {
  labels: ObjectLabelDto[];
  /** 預設列出的常用類別鍵（不在模型裡的會略過） */
  common: string[];
  model: string;
  known: boolean;
}

/** POST /api/objects/benchmark（管理員）：devices 省略時測目前使用的裝置；seconds 3 到 60，預設 10 */
export interface BenchmarkRequestDto {
  devices?: string[];
  seconds?: number;
}
