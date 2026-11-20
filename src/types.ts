export type CameraId = string & { readonly __brand: "CameraId" };
export type GroupId = string & { readonly __brand: "GroupId" };
export type Role = "user" | "admin";
export type StreamName = "main" | "sub";

export interface OnvifEndpoint {
  host: string;
  port: number;
  username: string;
  password: string;
}

export type CameraConnection =
  | { type: "tapo"; host: string; username: string; password: string }
  | {
      type: "rtsp";
      mainUrl: string;
      subUrl?: string;
      transport: "tcp" | "udp";
      onvif?: OnvifEndpoint;
    };

export type PtzMode = "auto" | "continuous" | "relative";

/** 每台攝影機的 PTZ 偏好；舊資料沒有這個欄位，一律經 `ptzPrefsOf` 取得預設值 */
export interface PtzPrefs {
  mode: PtzMode;
  /** 前端沒指定速度時使用，0.1 到 1.0 */
  speed: number;
  /**
   * 反轉左右／上下：有些相機（例如部分 Tapo 型號透過 ONVIF 控制時，或倒裝、開了畫面翻轉）的方向和
   * ONVIF 標準相反。在後端套用，網頁與 Home Assistant 看到的方向一致；舊資料沒有這兩個欄位時視為 false。
   */
  invertPan?: boolean;
  invertTilt?: boolean;
}

/** pixel = 畫面差分；onvif = 相機內建偵測；both = 任一來源觸發就算 */
export type DetectSource = "pixel" | "onvif" | "both";

/** 遮罩多邊形，頂點是 0 到 1 的比例座標 [x, y]，換解析度不用重畫 */
export interface MaskPolygon {
  points: [number, number][];
}

/** 物件辨識：off = 這台不辨識；annotate = 事件照常建立，只加上類別；filter = 等辨識到關注的類別才建立事件 */
export type ObjectMode = "off" | "annotate" | "filter";

/** 每台攝影機的動作偵測設定；舊資料沒有這個欄位，一律經 `detectConfigOf` 取得預設值 */
export interface DetectConfig {
  enabled: boolean;
  source: DetectSource;
  /** 像素門檻 1 到 255，越小越靈敏；前端的低、中、高對應 35、25、15 */
  threshold: number;
  /** 最小面積：活動區塊占未遮罩區塊的比例，0.001 到 0.5 */
  minArea: number;
  /** 連續這麼多秒沒有動作，事件才結束 */
  cooldownSec: number;
  /** 只影響畫面差分 */
  masks: MaskPolygon[];
  /**
   * 物件辨識要關注的類別鍵（見 `src/objects/labels.ts`）。對外（API、SSE）的值是「目前實際生效的」：
   * 系統沒開物件辨識或這台設為不辨識時一律是空陣列；HA 依這個清單為每個類別建立感應器。
   */
  labels: string[];
  objectMode: ObjectMode;
  /** 物件辨識的信心門檻，0.3 到 0.95 */
  objectScore: number;
}

/** 加入 Apple 家庭（HKSV）；舊資料沒有這個欄位，視為關閉 */
export interface HomekitCameraConfig {
  enabled: boolean;
}

export interface CameraConfig {
  name: string;
  enabled: boolean;
  connection: CameraConnection;
  ptz?: PtzPrefs;
  detect?: DetectConfig;
  homekit?: HomekitCameraConfig;
  record: {
    enabled: boolean;
    audio: boolean;
    /** true = 錄影直連相機，不經轉發層 */
    direct: boolean;
  };
}

export interface Camera {
  id: CameraId;
  /** 全站的排列順序：沒有分區的在前，接著依分區順序；同一區裡也照這個數字排 */
  position: number;
  /** 所屬分區；null 是沒有分區 */
  groupId: GroupId | null;
  config: CameraConfig;
  createdAt: number;
  updatedAt: number;
}

/** 攝影機分區（例如「一樓」「戶外」），由管理員命名與排序，所有人看到的一樣 */
export interface CameraGroup {
  id: GroupId;
  name: string;
  position: number;
}

/** 一次排好全部：分區的順序，以及每台攝影機依序屬於哪一區 */
export interface CameraArrangement {
  groups: GroupId[];
  cameras: { id: CameraId; groupId: GroupId | null }[];
}

/**
 * 運算裝置：auto（有可用的 GPU 就用）、cpu，或裝置識別字，例如 intel:GPU.0、nvidia:GPU-<uuid>。
 * 物件辨識（detector 列出）與影像解碼（`src/hwcodec/` 列出）用同一套識別字，同一張卡在兩邊是同一個值。
 * 存識別字而不是清單順序，重開機或換插槽不會指到別張卡。
 */
export type DeviceRef = string;

/**
 * 會用到運算裝置的工作。objects = 物件辨識的推論；decode = detect worker 解碼攝影機畫面
 * （動作偵測、快照、辨識畫面都來自它）。其他 ffmpeg 工作都是 -c copy，沒有影像解碼或編碼。
 */
export type DeviceTask = "objects" | "decode";

/** 物件辨識每秒送幾張畫面去辨識（每台攝影機、有動作時） */
export const OBJECT_FPS_CHOICES = [0.5, 1, 2, 3, 5] as const;

export interface ObjectSettings {
  enabled: boolean;
  /** "builtin" 或 `<dataDir>/models/` 裡的 .onnx 檔名 */
  model: string;
  /** 每台攝影機有動作時每秒辨識幾次，見 OBJECT_FPS_CHOICES */
  fps: number;
}

export interface Settings {
  siteName: string;
  /** 錄影根目錄；片段位於 <storagePath>/<cameraId>/<YYYYMMDD>/<HHMMSS>.mp4（UTC） */
  storagePath: string;
  retention: {
    continuousDays: number;
    eventDays: number;
    minFreeBytes: number;
  };
  rtsp: { externalEnabled: boolean };
  /** HKSV 總開關；關閉時不載入 HAP-NodeJS、不啟動 homekit worker。basePort 是第一台配件的 port */
  homekit: { enabled: boolean; basePort: number };
  objects: ObjectSettings;
  /** 每個工作用哪個裝置；舊資料沒有 decode，讀取時補預設值 */
  devices: Record<DeviceTask, DeviceRef>;
}

export const SEGMENT_SECONDS = 60;
export const EVENT_BUFFER_MS = 5_000;

export function defaultSettings(dataDir: string, recordingsDir = `${dataDir}/recordings`): Settings {
  return {
    siteName: "CookieNVR",
    storagePath: recordingsDir,
    retention: { continuousDays: 7, eventDays: 30, minFreeBytes: 5 * 1024 ** 3 },
    rtsp: { externalEnabled: true },
    homekit: { enabled: false, basePort: 51826 },
    objects: { enabled: false, model: "builtin", fps: 2 },
    // 解碼預設用 CPU：子碼流很便宜，硬體解碼要使用者自己選（見規格「影像硬體解碼」）
    devices: { objects: "auto", decode: "auto" },
  };
}

export interface Segment {
  id: number;
  cameraId: CameraId;
  path: string;
  startMs: number;
  /** null = 錄製中 */
  endMs: number | null;
  size: number;
}

export type Unsubscribe = () => void;

export interface CameraStore {
  list(): Camera[];
  get(id: CameraId): Camera | null;
  create(config: CameraConfig): Camera;
  update(id: CameraId, config: CameraConfig): Camera;
  remove(id: CameraId): void;
  /** 任何新增、修改、刪除、重新排列後呼叫，參數為最新的完整清單 */
  subscribe(listener: (cameras: Camera[]) => void): Unsubscribe;

  groups(): CameraGroup[];
  /** 新分區放在最後 */
  createGroup(name: string): CameraGroup;
  renameGroup(id: GroupId, name: string): CameraGroup;
  /** 分區裡的攝影機變成沒有分區，順序不變 */
  removeGroup(id: GroupId): void;
  /**
   * 照這份排列重排分區與攝影機。清單跟現況對不上時（別人剛新增或刪除）不報錯：
   * 不存在的 id 略過，漏掉的分區與攝影機接在最後、維持原本的相對順序。重送同一份結果不變。
   */
  arrange(arrangement: CameraArrangement): void;
  /** 分區新增、改名、刪除、重新排列後呼叫 */
  subscribeGroups(listener: (groups: CameraGroup[]) => void): Unsubscribe;
}

export interface SettingsStore {
  get(): Settings;
  update(patch: Partial<Settings>): Settings;
  subscribe(listener: (settings: Settings) => void): Unsubscribe;
}

export type WorkerKind =
  | "restream"
  | "record"
  | "detect"
  | "detector"
  | "classifier"
  | "live"
  | "homekit"
  | "hksv-stream"
  | "export";

export interface WorkerSpec {
  /** 全域唯一，例如 "restream"、"record:<cameraId>" */
  id: string;
  kind: WorkerKind;
  cmd: string[];
  env?: Record<string, string>;
  cwd?: string;
  /**
   * 卡死判定。supervisor 在 worker 啟動滿 graceMs 後，每 intervalMs 呼叫一次 healthy()；
   * 回傳 false 就以 reason "stall" 重啟。
   */
  stall?: {
    intervalMs: number;
    graceMs: number;
    healthy: () => boolean | Promise<boolean>;
  };
  /**
   * 宣告後 stdout 是資料而不是日誌：每次啟動都把該次的 stdout 交給它讀到結束，不進輸出尾端（stderr 照舊）。
   * 讀取要跟得上輸出，否則子程序會卡在寫入。
   */
  readStdout?: (stdout: ReadableStream<Uint8Array>) => Promise<void>;
}

export type WorkerState = "starting" | "running" | "backoff" | "stopped";
export type RestartReason = "exit" | "stall" | "memory" | "manual" | "spec-changed";

export interface WorkerStatus {
  id: string;
  kind: WorkerKind;
  state: WorkerState;
  /** 10 分鐘內重啟超過 10 次 */
  unstable: boolean;
  pid: number | null;
  startedAt: number | null;
  restarts: number;
  lastRestart: { reason: RestartReason; at: number; exitCode: number | null } | null;
  stderrTail: string[];
}

export interface Supervisor {
  /**
   * 宣告式對帳：傳入「現在應該存在的全部 worker」。
   * 缺的啟動、多的停止、cmd/env/cwd 有變的重啟；重複呼叫同一份清單不產生任何動作。
   */
  apply(specs: WorkerSpec[]): void;
  restart(id: string, reason?: RestartReason): void;
  status(): WorkerStatus[];
  subscribe(listener: (status: WorkerStatus) => void): Unsubscribe;
  /** 停止所有 worker 並等到子程序全部結束 */
  shutdown(): Promise<void>;
}

export interface Principal {
  userId: number;
  username: string;
  role: Role;
  via: "session" | "token";
}

export type RouteAccess = "public" | "user" | "admin" | "internal";

export interface RouteContext {
  req: Request;
  url: URL;
  params: Record<string, string>;
  /** access 為 user / admin 時保證非 null */
  principal: Principal | null;
  ip: string;
}

export interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** 例如 "/api/cameras/:id/recordings" */
  path: string;
  /** internal = 只接受 127.0.0.1 */
  access: RouteAccess;
  /** 接受的非 JSON 請求本體（例如上傳 zip）；沒寫時 POST／PUT／DELETE 的本體必須是 application/json */
  accepts?: readonly string[];
  handler(ctx: RouteContext): Response | Promise<Response>;
}
