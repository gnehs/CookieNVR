export type CameraId = string & { readonly __brand: "CameraId" };
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

export interface CameraConfig {
  name: string;
  enabled: boolean;
  connection: CameraConnection;
  record: {
    enabled: boolean;
    audio: boolean;
    /** true = 錄影直連相機，不經轉發層 */
    direct: boolean;
  };
}

export interface Camera {
  id: CameraId;
  position: number;
  config: CameraConfig;
  createdAt: number;
  updatedAt: number;
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
}

export const SEGMENT_SECONDS = 60;
export const EVENT_BUFFER_MS = 5_000;

export function defaultSettings(dataDir: string): Settings {
  return {
    siteName: "CookieNVR",
    storagePath: `${dataDir}/recordings`,
    retention: { continuousDays: 7, eventDays: 30, minFreeBytes: 5 * 1024 ** 3 },
    rtsp: { externalEnabled: true },
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
  /** 任何新增、修改、刪除後呼叫，參數為最新的完整清單 */
  subscribe(listener: (cameras: Camera[]) => void): Unsubscribe;
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
  handler(ctx: RouteContext): Response | Promise<Response>;
}
