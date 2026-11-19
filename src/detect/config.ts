import type { CameraConfig, DetectConfig } from "../types.ts";

export const DEFAULT_DETECT: DetectConfig = {
  enabled: true,
  source: "pixel",
  threshold: 25,
  minArea: 0.005,
  cooldownSec: 10,
  masks: [],
  labels: ["person"],
  objectMode: "annotate",
  objectScore: 0.5,
};

/** 前端「靈敏度」的三個預設檔對應的像素門檻；其他值顯示為自訂 */
export const SENSITIVITY_PRESETS = { low: 35, medium: 25, high: 15 } as const;

export const LIMITS = {
  threshold: { min: 1, max: 255 },
  minArea: { min: 0.001, max: 0.5 },
  cooldownSec: { min: 1, max: 300 },
  masks: 16,
  points: { min: 3, max: 32 },
  objectScore: { min: 0.3, max: 0.95 },
} as const;

/** 舊資料沒有 detect 欄位 */
export function detectConfigOf(config: CameraConfig): DetectConfig {
  return { ...DEFAULT_DETECT, ...config.detect };
}

export const usesPixel = (d: DetectConfig) => d.enabled && d.source !== "onvif";
export const usesOnvif = (d: DetectConfig) => d.enabled && d.source !== "pixel";
