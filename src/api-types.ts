import type { OnvifErrorKind } from "./onvif/errors.ts";
import type { CameraConfig, CameraId, PtzMode, Role, Settings, WorkerStatus } from "./types.ts";

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
 * labels：物件類別；相機事件的人形、車輛、寵物也記在這裡（person、vehicle、pet）。
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
 */
export type StreamMessage =
  | { type: "snapshot"; data: StreamSnapshotDto }
  | { type: "cameras"; data: CameraDto[] }
  | { type: "camera"; data: CameraDto }
  | { type: "worker"; data: WorkerStatus }
  | { type: "event"; data: { phase: "start" | "end"; event: EventDto } }
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
