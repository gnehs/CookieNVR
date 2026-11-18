import type { CameraConfig, CameraId, Role, Settings, WorkerStatus } from "./types.ts";

export const API_VERSION = 1;

export interface ErrorDto {
  error: string;
}

export interface InfoDto {
  version: string;
  apiVersion: number;
  needsSetup: boolean;
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

export type ProbeResult =
  | { ok: true; main: StreamInfo; sub: StreamInfo | null; snapshotJpegBase64: string | null }
  | { ok: false; error: string };

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
  usage: { cameraId: CameraId; bytes: number }[];
  logs: string[];
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
