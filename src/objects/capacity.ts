import type { InferenceDeviceKind } from "../api-types.ts";

/**
 * 測速只量到「推論程序一張接一張做，每秒能做幾張」，是最佳情況。換算成可同時處理幾台攝影機時要扣掉：
 * - CPU：錄影、解碼、動作偵測同時在用，推論只算測得速度的一半。
 * - GPU：推論在顯示卡，但 JPEG 解碼與前後處理仍在 CPU，算八成。
 * 與 detector/selftest.py 的 HEADROOM 相同。
 */
export const HEADROOM: Record<InferenceDeviceKind, number> = { cpu: 0.5, intel: 0.8, nvidia: 0.8 };

/** 測得每秒 fps 張 → 同時有動作時，每台每秒辨識 perCamera 次，大約可以撐幾台 */
export function camerasSupported(fps: number, kind: InferenceDeviceKind, perCamera: number): number {
  if (!(fps > 0) || !(perCamera > 0)) return 0;
  return Math.max(0, Math.floor((fps * HEADROOM[kind]) / perCamera));
}

/**
 * 目前的設定夠不夠：最壞的情況是所有開了物件辨識的攝影機同時有動作。
 * - enough：全部同時有動作也來得及
 * - partial：同時有動作的攝影機超過 supported 台時會來不及（多出來的畫面會被丟掉）
 */
export type CapacityVerdict = { state: "enough"; supported: number; cameras: number } | { state: "partial"; supported: number; cameras: number };

export function verdict(fps: number, kind: InferenceDeviceKind, perCamera: number, cameras: number): CapacityVerdict {
  const supported = camerasSupported(fps, kind, perCamera);
  return { state: supported >= cameras ? "enough" : "partial", supported, cameras };
}

/** 實際運作時的負載：最近一段時間每秒處理幾張、丟掉的比例 */
export interface LoadSample {
  /** 最近 60 秒平均每秒推論幾張 */
  rateFps: number;
  /** 最近 5 分鐘被丟掉的畫面占送來的比例（0 到 1）；送來的太少（不到 20 張）時為 null */
  dropRatio: number | null;
}

/** 持續丟畫面超過一成就提醒；畫面太少不下結論 */
export const DROP_WARN_RATIO = 0.1;

/** 依時間戳記算最近的速率；pure，給 service 與測試共用 */
export function loadSample(processedAt: readonly number[], droppedAt: readonly number[], now: number): LoadSample {
  const recent = processedAt.filter((t) => now - t <= 60_000).length;
  const p5 = processedAt.filter((t) => now - t <= 300_000).length;
  const d5 = droppedAt.filter((t) => now - t <= 300_000).length;
  const offered = p5 + d5;
  return { rateFps: Math.round((recent / 60) * 10) / 10, dropRatio: offered < 20 ? null : d5 / offered };
}
