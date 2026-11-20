import type { ObjectHit } from "../events/lifecycle.ts";
import type { DetectConfig, MaskPolygon } from "../types.ts";

/** detector 回傳的一個物件；box 是相對於畫面的 0 到 1 座標 (x1, y1, x2, y2) */
export interface Detection {
  label: string;
  score: number;
  box: [number, number, number, number];
}

/** 偶奇規則：點在多邊形內 */
export function insidePolygon(x: number, y: number, poly: MaskPolygon): boolean {
  const pts = poly.points;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 一張辨識結果 → 交給事件狀態機的物件：只留關注的類別、超過門檻、框中心不在排除區域（含物件專用的）內的；
 * 同一類別只留信心最高的一個。
 */
export function toHits(detections: readonly Detection[], detect: Pick<DetectConfig, "labels" | "objectScore" | "masks" | "objectMasks">): ObjectHit[] {
  const watched = new Set(detect.labels);
  const zones = [...detect.masks, ...detect.objectMasks];
  const best = new Map<string, number>();
  for (const d of detections) {
    if (!watched.has(d.label) || d.score < detect.objectScore) continue;
    const cx = (d.box[0] + d.box[2]) / 2;
    const cy = (d.box[1] + d.box[3]) / 2;
    if (zones.some((m) => insidePolygon(cx, cy, m))) continue;
    if (d.score > (best.get(d.label) ?? 0)) best.set(d.label, d.score);
  }
  return [...best].map(([label, score]) => ({ label, score }));
}

/** 同類別的兩個框重疊到這個程度（IoU）就當作同一個位置 */
const SAME_SPOT_IOU = 0.6;
/** 在同一個位置待了這麼久的物件當作靜止（停著的車），不算進事件 */
export const STATIONARY_MS = 30_000;
/** 連續這麼多張辨識都沒在原位看到，就忘掉這個位置 */
const FORGET_MISSES = 10;
/** 一台攝影機最多記這麼多個位置 */
const MAX_SPOTS = 64;

function iou(a: Detection["box"], b: Detection["box"]): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const area = (r: Detection["box"]) => (r[2] - r[0]) * (r[3] - r[1]);
  return inter / (area(a) + area(b) - inter);
}

interface Spot {
  label: string;
  /** 第一次在這裡看到時的框；不跟著更新，免得緩慢移動被當成原地不動 */
  box: Detection["box"];
  since: number;
  misses: number;
}

/**
 * 一台攝影機的靜止物件記憶。物件辨識是對整張畫面做的，畫面別處一有動作，停著的車也會被辨識到；
 * 同類別、框幾乎沒動、而且已經在那裡待了 STATIONARY_MS 以上的物件就濾掉。
 * 記憶跨事件保留（兩次事件之間沒有辨識，不算沒看到），車子開走後連續沒看到才忘掉。
 */
export class StationaryFilter {
  private spots: Spot[] = [];

  /** 回傳不是靜止的物件，同時更新記憶；要看全部的辨識結果（不只關注類別、超過門檻的），信心值在門檻附近跳動才不會被忘掉 */
  moving(detections: readonly Detection[], at: number): Detection[] {
    const matched = new Set<Spot>();
    const out: Detection[] = [];
    for (const d of detections) {
      let best: Spot | null = null;
      let bestIou = SAME_SPOT_IOU;
      for (const s of this.spots) {
        if (s.label !== d.label || matched.has(s)) continue;
        const v = iou(s.box, d.box);
        if (v >= bestIou) [best, bestIou] = [s, v];
      }
      if (!best) {
        best = { label: d.label, box: d.box, since: at, misses: 0 };
        this.spots.push(best);
      }
      matched.add(best);
      best.misses = 0;
      if (at - best.since < STATIONARY_MS) out.push(d);
    }
    for (const s of this.spots) if (!matched.has(s)) s.misses++;
    this.spots = this.spots.filter((s) => s.misses < FORGET_MISSES);
    if (this.spots.length > MAX_SPOTS) this.spots = this.spots.sort((a, b) => a.misses - b.misses).slice(0, MAX_SPOTS);
    return out;
  }
}
