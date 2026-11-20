import type { CameraConfig, DetectConfig } from "../types.ts";

export const DEFAULT_DETECT: DetectConfig = {
  enabled: true,
  source: "pixel",
  threshold: 25,
  minArea: 0.005,
  cooldownSec: 10,
  masks: [],
  objectMasks: [],
  labels: ["person"],
  objectMode: "annotate",
  objectScore: 0.5,
};

/** 前端「靈敏度」的三個預設檔對應的像素門檻；其他值顯示為自訂 */
export const SENSITIVITY_PRESETS = { low: 35, medium: 25, high: 15 } as const;

/**
 * 設定頁預覽靈敏度用：worker 在有人看「畫面變化」時，每張畫面依這些像素門檻各算一個分數，前端依滑桿的值內插。
 * 由小到大，含三個預設檔，低值較密（滑桿是對數刻度）。
 */
export const PREVIEW_THRESHOLDS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 21, 25, 30, 35, 42, 50, 60, 75, 100, 150, 255] as const;

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
