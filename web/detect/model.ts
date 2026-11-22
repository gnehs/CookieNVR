import { LIMITS, PREVIEW_THRESHOLDS, SENSITIVITY_PRESETS } from "../../src/detect/config.ts";

export type Sensitivity = keyof typeof SENSITIVITY_PRESETS | "custom";

export function sensitivityOf(threshold: number): Sensitivity {
  for (const [k, v] of Object.entries(SENSITIVITY_PRESETS)) if (v === threshold) return k as Sensitivity;
  return "custom";
}

/**
 * 滑桿位置 0 到 100 與實際數值的換算，對數刻度：常用的小數值有足夠的拖曳距離。
 * invert：位置越大數值越小（像素門檻越小越靈敏，滑桿往右是「更靈敏」）。
 */
function logScale(min: number, max: number, invert: boolean) {
  const span = Math.log(max / min);
  return {
    toPos: (v: number) => {
      const p = (Math.log(Math.min(max, Math.max(min, v)) / min) / span) * 100;
      return invert ? 100 - p : p;
    },
    fromPos: (pos: number) => min * Math.exp(((invert ? 100 - pos : pos) / 100) * span),
  };
}

const thresholdScale = logScale(LIMITS.threshold.min, LIMITS.threshold.max, true);
export const thresholdToPos = thresholdScale.toPos;
export const posToThreshold = (pos: number) => Math.round(thresholdScale.fromPos(pos));

const areaScale = logScale(LIMITS.minArea.min, LIMITS.minArea.max, false);
export const areaToPos = areaScale.toPos;
/** 兩位有效數字，存回去的值不會是 0.0048731 這種 */
export const posToArea = (pos: number) => Number(areaScale.fromPos(pos).toPrecision(2));

/** 0.005 → 「0.5%」 */
export function formatArea(area: number): string {
  const pct = area * 100;
  return `${pct >= 10 ? Math.round(pct) : Number(pct.toPrecision(2))}%`;
}

/**
 * 分數在量表上的高度（0 到 1）。用相對於觸發線的比例，觸發線固定在 TRIGGER_Y；
 * 越過之後漸漸飽和，大動作不會把小變化壓扁到看不見。
 */
export const TRIGGER_Y = 0.4;
const K = 1 / TRIGGER_Y - 1;
export function meterY(score: number, minArea: number): number {
  const r = Math.max(0, score) / minArea;
  return r / (r + K);
}

/**
 * 從 worker 的預覽分數（`PREVIEW_THRESHOLDS` 各門檻下的分數）推算任一像素門檻下的分數：門檻剛好在表上就直接用，
 * 落在兩個門檻之間就線性內插（分數隨門檻單調下降，內插不會超出兩端）。
 */
export function scoreAtThreshold(curve: readonly number[], threshold: number): number {
  const ts = PREVIEW_THRESHOLDS;
  if (threshold <= ts[0]) return curve[0] ?? 0;
  for (let i = 1; i < ts.length; i++) {
    const hi = ts[i]!;
    if (threshold <= hi) {
      const lo = ts[i - 1]!;
      const f = (threshold - lo) / (hi - lo);
      return (curve[i - 1] ?? 0) + f * ((curve[i] ?? 0) - (curve[i - 1] ?? 0));
    }
  }
  return curve[ts.length - 1] ?? 0;
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function centroid(points: readonly [number, number][]): [number, number] {
  let x = 0;
  let y = 0;
  for (const [px, py] of points) {
    x += px;
    y += py;
  }
  return [x / points.length, y / points.length];
}

/** 畫到一半的多邊形點數夠了，可以收合 */
export const canClose = (points: readonly unknown[]) => points.length >= LIMITS.points.min;
export const canAddMask = (masks: readonly unknown[]) => masks.length < LIMITS.masks;
