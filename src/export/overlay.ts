/**
 * Boxes burned into an event clip: when each recorded detection shows up in the exported file,
 * and the ffmpeg filter graph that draws them.
 */

import type { EventBoxDto } from "../api-types.ts";
import type { BoxSample } from "../events/store.ts";
import { drawbox } from "../objects/draw.ts";
import type { PlanPart } from "./plan.ts";

/** A detection stays on screen until the next one, but not longer than this when recognition paused. */
export const BOX_HOLD_MS = 2_000;
/** Upper bound on drawbox filters in one graph; longer events are thinned to stay under it. */
export const MAX_OVERLAY_BOXES = 300;
/**
 * How long after the recorded frame a detection's timestamp lands. `at` is when the sub stream's JPEG reached the
 * main process, which trails the main stream the clip is cut from. Unmeasured, so no correction yet.
 */
export const DETECTION_LAG_MS = 0;
/** Two boxes of the same label closer than this on every edge (fraction of the frame) are drawn as one. */
const SAME_BOX = 0.02;

export interface OverlayBox extends EventBoxDto {
  /** Seconds on the exported file's timeline. */
  fromS: number;
  toS: number;
}

interface Span {
  label: string;
  score: number;
  box: EventBoxDto["box"];
  fromMs: number;
  toMs: number;
}

const near = (a: EventBoxDto["box"], b: EventBoxDto["box"]) => a.every((v, i) => Math.abs(v - b[i]!) <= SAME_BOX);

/** Wall-clock spans; a box that stays put across consecutive samples becomes one span. */
function spans(samples: readonly BoxSample[], holdMs: number): Span[] {
  const out: Span[] = [];
  let open: Span[] = [];
  samples.forEach((s, i) => {
    const fromMs = s.atMs - DETECTION_LAG_MS;
    const next = samples[i + 1];
    const toMs = Math.min(next ? next.atMs - DETECTION_LAG_MS : Infinity, fromMs + holdMs);
    const stillOpen: Span[] = [];
    for (const b of s.boxes) {
      const j = open.findIndex((o) => o.label === b.label && o.toMs === fromMs && near(o.box, b.box));
      if (j >= 0) {
        const [o] = open.splice(j, 1);
        o!.toMs = toMs;
        stillOpen.push(o!);
      } else {
        const span = { label: b.label, score: b.score, box: b.box, fromMs, toMs };
        out.push(span);
        stillOpen.push(span);
      }
    }
    open = stillOpen;
  });
  return out;
}

/** The exported file plays the parts back to back, so a wall-clock span maps into each part it overlaps. */
function toOutput(parts: readonly PlanPart[], fromMs: number, toMs: number): { fromS: number; toS: number }[] {
  const out: { fromS: number; toS: number }[] = [];
  let before = 0;
  for (const p of parts) {
    const a = Math.max(fromMs, p.startMs);
    const b = Math.min(toMs, p.startMs + p.coveredMs);
    if (b > a) out.push({ fromS: (before + a - p.startMs) / 1000, toS: (before + b - p.startMs) / 1000 });
    before += p.coveredMs;
  }
  return out;
}

export function overlayBoxes(samples: readonly BoxSample[], parts: readonly PlanPart[]): OverlayBox[] {
  const sorted = samples.filter((s) => s.boxes.length > 0).sort((a, b) => a.atMs - b.atMs);
  for (let stride = 1; ; stride *= 2) {
    const kept = sorted.filter((_, i) => i % stride === 0);
    const boxes = spans(kept, BOX_HOLD_MS * stride).flatMap(({ fromMs, toMs, ...b }) => toOutput(parts, fromMs, toMs).map((t) => ({ ...b, ...t })));
    if (boxes.length <= MAX_OVERLAY_BOXES || kept.length <= 1) return boxes.slice(0, MAX_OVERLAY_BOXES);
  }
}

/** A boxed clip is re-encoded anyway, so it is scaled down to this height; a phone notification does not need more. */
export const OVERLAY_MAX_HEIGHT = 720;

/**
 * The video filter graph for a boxed clip. ffmpeg runs with -copyts so `t` is the concat timeline, where each part's
 * inpoint lands exactly; trim drops the frames decoded from the keyframe before the first inpoint, which would
 * otherwise shift everything by up to a GOP, and setpts makes the file start at zero.
 */
export function overlayFilter(boxes: readonly OverlayBox[]): string {
  return [
    "trim=start=0",
    `scale=w=-2:h='min(${OVERLAY_MAX_HEIGHT},trunc(ih/2)*2)'`,
    ...boxes.map((b) => drawbox(b, b)),
    // A 10-bit or 4:2:2 source would otherwise become an H.264 profile phones cannot play.
    "format=yuv420p",
    "setpts=PTS-STARTPTS",
  ].join(",\n");
}
