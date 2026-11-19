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
 * 一張辨識結果 → 交給事件狀態機的物件：只留關注的類別、超過門檻、框中心不在遮罩內的；
 * 同一類別只留信心最高的一個。
 */
export function toHits(detections: readonly Detection[], detect: Pick<DetectConfig, "labels" | "objectScore" | "masks">): ObjectHit[] {
  const watched = new Set(detect.labels);
  const best = new Map<string, number>();
  for (const d of detections) {
    if (!watched.has(d.label) || d.score < detect.objectScore) continue;
    const cx = (d.box[0] + d.box[2]) / 2;
    const cy = (d.box[1] + d.box[3]) / 2;
    if (detect.masks.some((m) => insidePolygon(cx, cy, m))) continue;
    if (d.score > (best.get(d.label) ?? 0)) best.set(d.label, d.score);
  }
  return [...best].map(([label, score]) => ({ label, score }));
}
