import { detectConfigOf } from "../detect/config.ts";
import type { CameraConfig } from "../types.ts";

/**
 * 對外（API、SSE）的攝影機設定：`detect.labels` 只放目前實際生效的類別。系統沒開物件辨識、
 * 或這台設為不辨識時是空陣列；HA 依這個清單為每個類別建立感應器。存起來的勾選不受影響。
 */
export function publicCameraConfig(config: CameraConfig, objectsEnabled: boolean): CameraConfig {
  const detect = detectConfigOf(config);
  const active = objectsEnabled && detect.enabled && detect.objectMode !== "off";
  return { ...config, detect: { ...detect, labels: active ? detect.labels : [] } };
}

/**
 * 修改攝影機時，用戶端送回來的是 publicCameraConfig 的結果，生效中以外的勾選會是空的：
 * 系統沒開物件辨識時沿用原本的三個物件辨識欄位，這台設為不辨識時沿用原本的勾選，免得來回一次就清掉。
 */
export function mergeCameraConfig(incoming: CameraConfig, existing: CameraConfig, objectsEnabled: boolean): CameraConfig {
  if (!incoming.detect) return incoming;
  const prev = detectConfigOf(existing);
  if (!objectsEnabled) return { ...incoming, detect: { ...incoming.detect, labels: prev.labels, objectMode: prev.objectMode, objectScore: prev.objectScore } };
  if (incoming.detect.objectMode === "off") return { ...incoming, detect: { ...incoming.detect, labels: prev.labels } };
  return incoming;
}
