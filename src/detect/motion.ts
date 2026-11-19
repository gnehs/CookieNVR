import type { DetectFrameState } from "../api-types.ts";
import type { MaskPolygon } from "../types.ts";

export const FRAME_W = 320;
export const FRAME_H = 180;
export const FRAME_BYTES = FRAME_W * FRAME_H;

const BLOCK = 8;
/** 區塊內變動像素超過這個比例才算活動區塊 */
const BLOCK_ACTIVE_RATIO = 0.25;
/** 區塊內未遮罩的像素少於這個比例就不納入計算，遮罩邊緣的碎塊才不會變成雜訊 */
const BLOCK_MIN_ELIGIBLE = 0.25;
/** 分數超過這個值視為光線突變 */
const LIGHT_CHANGE_SCORE = 0.7;
const BACKGROUND_ALPHA = 0.05;
export const WARMUP_FRAMES = 10;

export interface DiffParams {
  /** 像素門檻 1 到 255 */
  threshold: number;
  /** 最小面積 0 到 1 */
  minArea: number;
}

export interface Verdict {
  state: DetectFrameState;
  score: number | null;
  motion: boolean;
  /** 只在要求預覽時：依 `previewThresholds` 各門檻算出的分數 */
  curve?: number[];
}

/**
 * 把遮罩多邊形畫成 w×h 的點陣，1 = 遮罩內（不參與計算）。以像素中心做奇偶規則判斷。
 */
export function rasterizeMasks(masks: MaskPolygon[], w = FRAME_W, h = FRAME_H): Uint8Array {
  const out = new Uint8Array(w * h);
  for (const { points } of masks) {
    if (points.length < 3) continue;
    const pts = points.map(([x, y]) => [x * w, y * h] as const);
    for (let y = 0; y < h; y++) {
      const cy = y + 0.5;
      const xs: number[] = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i]!;
        const [xj, yj] = pts[j]!;
        if (yi > cy !== yj > cy) xs.push(xi + ((cy - yi) / (yj - yi)) * (xj - xi));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil(xs[k]! - 0.5));
        const to = Math.min(w - 1, Math.ceil(xs[k + 1]! - 0.5) - 1);
        for (let x = from; x <= to; x++) out[y * w + x] = 1;
      }
    }
  }
  return out;
}

/** 3×3 平均模糊；邊緣只取畫面內的鄰居 */
export function blur3x3(src: Uint8Array, dst: Float32Array, w = FRAME_W, h = FRAME_H): void {
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : y;
    const y1 = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : x;
      const x1 = x < w - 1 ? x + 1 : x;
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * w;
        for (let xx = x0; xx <= x1; xx++) {
          sum += src[row + xx]!;
          n++;
        }
      }
      dst[y * w + x] = sum / n;
    }
  }
}

/** 活動區塊 ÷ 納入計算的區塊；畫面全被遮住時回 0 */
export function scoreFrame(frame: Float32Array, background: Float32Array, mask: Uint8Array | null, threshold: number, w = FRAME_W, h = FRAME_H): number {
  let eligible = 0;
  let active = 0;
  for (let by = 0; by < h; by += BLOCK) {
    const yEnd = Math.min(h, by + BLOCK);
    for (let bx = 0; bx < w; bx += BLOCK) {
      const xEnd = Math.min(w, bx + BLOCK);
      let pixels = 0;
      let open = 0;
      let changed = 0;
      for (let y = by; y < yEnd; y++) {
        for (let x = bx; x < xEnd; x++) {
          const i = y * w + x;
          pixels++;
          if (mask && mask[i]) continue;
          open++;
          if (Math.abs(frame[i]! - background[i]!) > threshold) changed++;
        }
      }
      if (open < pixels * BLOCK_MIN_ELIGIBLE) continue;
      eligible++;
      if (changed > open * BLOCK_ACTIVE_RATIO) active++;
    }
  }
  return eligible === 0 ? 0 : active / eligible;
}

/**
 * 同一張畫面在多個像素門檻下的分數（和 `scoreFrame` 同樣的區塊規則），一次走完所有像素。
 * thresholds 由小到大、皆為整數。差值 d 超過門檻 t 等同 ceil(d) - 1 >= t，所以先換成整數再查表。
 */
export function scoreCurve(frame: Float32Array, background: Float32Array, mask: Uint8Array | null, thresholds: readonly number[], w = FRAME_W, h = FRAME_H): number[] {
  const n = thresholds.length;
  // bucket[key] = 有幾個門檻 <= key，也就是這個像素在幾個門檻下算「變動」
  const bucket = new Uint8Array(256);
  for (let key = 0, k = 0; key < 256; key++) {
    while (k < n && thresholds[k]! <= key) k++;
    bucket[key] = k;
  }
  const hist = new Uint32Array(n + 1);
  const active = new Uint32Array(n);
  let eligible = 0;
  for (let by = 0; by < h; by += BLOCK) {
    const yEnd = Math.min(h, by + BLOCK);
    for (let bx = 0; bx < w; bx += BLOCK) {
      const xEnd = Math.min(w, bx + BLOCK);
      hist.fill(0);
      let pixels = 0;
      let open = 0;
      for (let y = by; y < yEnd; y++) {
        for (let x = bx; x < xEnd; x++) {
          const i = y * w + x;
          pixels++;
          if (mask && mask[i]) continue;
          open++;
          const key = Math.ceil(Math.abs(frame[i]! - background[i]!)) - 1;
          hist[key < 0 ? 0 : bucket[key > 255 ? 255 : key]!]!++;
        }
      }
      if (open < pixels * BLOCK_MIN_ELIGIBLE) continue;
      eligible++;
      // 門檻 k 下的變動像素 = 在超過 k 個門檻下變動的像素
      let changed = 0;
      for (let k = n - 1; k >= 0; k--) {
        changed += hist[k + 1]!;
        if (changed > open * BLOCK_ACTIVE_RATIO) active[k]!++;
      }
    }
  }
  return Array.from(active, (a) => (eligible === 0 ? 0 : a / eligible));
}

/**
 * 背景差分偵測器。狀態只有背景與暖機計數；`reset()` 用在重連與鏡頭停下之後。
 * 每張畫面 O(像素數)，不配置新記憶體。
 */
export class MotionDetector {
  private readonly blurred = new Float32Array(FRAME_BYTES);
  private readonly background = new Float32Array(FRAME_BYTES);
  private hasBackground = false;
  private warmup = WARMUP_FRAMES;
  private mask: Uint8Array | null = null;

  setMasks(masks: MaskPolygon[]): void {
    this.mask = masks.length ? rasterizeMasks(masks) : null;
  }

  reset(): void {
    this.hasBackground = false;
    this.warmup = WARMUP_FRAMES;
  }

  process(gray: Uint8Array, params: DiffParams, previewThresholds?: readonly number[]): Verdict {
    blur3x3(gray, this.blurred);
    if (!this.hasBackground) {
      this.background.set(this.blurred);
      this.hasBackground = true;
    }
    const score = scoreFrame(this.blurred, this.background, this.mask, params.threshold);
    // 和分數用同一個背景（更新背景之前）算，預覽才和實際判斷一致
    const curve = previewThresholds ? scoreCurve(this.blurred, this.background, this.mask, previewThresholds) : undefined;
    if (score > LIGHT_CHANGE_SCORE) {
      this.background.set(this.blurred);
      return { state: "light", score: null, motion: false };
    }
    const bg = this.background;
    const f = this.blurred;
    for (let i = 0; i < FRAME_BYTES; i++) bg[i] = bg[i]! + BACKGROUND_ALPHA * (f[i]! - bg[i]!);
    if (this.warmup > 0) {
      this.warmup--;
      return { state: "warmup", score: null, motion: false };
    }
    return { state: "ok", score, motion: score > params.minArea, ...(curve ? { curve } : {}) };
  }
}
