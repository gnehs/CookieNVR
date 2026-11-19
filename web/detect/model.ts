import type { EventDto } from "../../src/api-types.ts";
import { LIMITS, PREVIEW_THRESHOLDS, SENSITIVITY_PRESETS } from "../../src/detect/config.ts";
import { EVENT_PREROLL_MS } from "../timeline/model.ts";
import { type DayKey, dayOf } from "../ui/date-logic.ts";

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

const pad = (n: number) => String(n).padStart(2, "0");
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

/** 瀏覽器時區的 YYYY-MM-DD */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 瀏覽器時區的一天 [開始, 結束) */
export function dayBounds(key: string): [number, number] {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

/** 「今天」「昨天」，其他是「11/17 週二」；不同年份才寫年 */
export function dayTitle(key: string, now: number): string {
  if (key === dayKey(now)) return "今天";
  if (key === dayKey(dayBounds(dayKey(now))[0] - 1)) return "昨天";
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const wd = WEEKDAY[new Date(y, m - 1, d).getDay()];
  return `${y === new Date(now).getFullYear() ? "" : `${y}/`}${m}/${d} 週${wd}`;
}

/** 依開始時間由新到舊、去掉重複；同一筆以後來的為準（例如進行中變成已結束） */
export function mergeEvents(list: readonly EventDto[], incoming: readonly EventDto[]): EventDto[] {
  const byId = new Map(list.map((e) => [e.id, e]));
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.startMs - a.startMs || b.id - a.id);
}

/** 已排好序（由新到舊）的事件依瀏覽器時區分天 */
export function groupByDay(events: readonly EventDto[]): { key: string; events: EventDto[] }[] {
  const out: { key: string; events: EventDto[] }[] = [];
  for (const e of events) {
    const key = dayKey(e.startMs);
    const last = out[out.length - 1];
    if (last?.key === key) last.events.push(e);
    else out.push({ key, events: [e] });
  }
  return out;
}

/** 回放頁（`/recordings`）的 search：從事件開始前 5 秒播起 */
export function playbackSearch(e: Pick<EventDto, "cameraId" | "startMs">): { camera: string; date: DayKey; t: number } {
  return { camera: e.cameraId, date: dayOf(e.startMs), t: e.startMs - EVENT_PREROLL_MS };
}
