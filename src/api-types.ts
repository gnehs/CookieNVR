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

export interface EventDto {
  id: number;
  cameraId: CameraId;
  source: "pixel" | "onvif";
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
