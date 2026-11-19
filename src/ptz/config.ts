import { splitHostPort } from "../restream/source-urls.ts";
import type { CameraConfig, CameraConnection, OnvifEndpoint, PtzPrefs } from "../types.ts";

export const TAPO_ONVIF_PORT = 2020;

export const DEFAULT_PTZ_PREFS: PtzPrefs = { mode: "auto", speed: 0.5, invertPan: false, invertTilt: false };

/** 舊資料沒有 ptz 欄位 */
export function ptzPrefsOf(config: CameraConfig): PtzPrefs {
  return { ...DEFAULT_PTZ_PREFS, ...config.ptz };
}

/** 依這台的反轉設定換算移動方向；變焦不受影響 */
export function orientMove<T extends { pan: number; tilt: number }>(move: T, prefs: PtzPrefs): T {
  return { ...move, pan: prefs.invertPan ? -move.pan : move.pan, tilt: prefs.invertTilt ? -move.tilt : move.tilt };
}

/**
 * Tapo 的 ONVIF 固定在同主機的 2020 埠，帳密與 RTSP 相同。host 欄可能帶自訂的 RTSP 埠，
 * 那個埠與 ONVIF 無關。通用 RTSP 沒填 ONVIF 就是 null。
 */
export function onvifEndpointOf(conn: CameraConnection): OnvifEndpoint | null {
  if (conn.type === "rtsp") return conn.onvif ?? null;
  return { host: splitHostPort(conn.host).host, port: TAPO_ONVIF_PORT, username: conn.username, password: conn.password };
}
