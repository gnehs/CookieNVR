/**
 * Where each appended segment sits in the SourceBuffer, and conversion between
 * buffer time (video.currentTime, seconds) and wall time (UTC ms).
 *
 * Segment start times come from second-precision file names, and consecutive
 * files overlap by a fraction of a second, so the buffer position is measured
 * from the fragments themselves and never derived from the wall clock.
 */

export interface Placement {
  segId: number;
  /** wall time the segment's first frame stands for (its index start) */
  wallStart: number;
  /** buffer seconds of the first appended fragment */
  bufStart: number;
  /** buffer seconds where the last appended fragment ends; grows while a segment is tailed */
  bufEnd: number;
}

export type TimeMap = readonly Placement[];

/** Wall-clock difference beyond which two segments are not one continuous recording. */
export const GAP_MS = 2_000;

/** True when `next` continues `prev` without a real gap in the recording. */
export function continues(prev: Placement, next: Placement): boolean {
  return next.wallStart - wallEnd(prev) <= GAP_MS;
}

const wallEnd = (p: Placement) => p.wallStart + (p.bufEnd - p.bufStart) * 1000;

/** Index of the last placement whose bufStart <= t, or -1. */
function byBuf(map: TimeMap, t: number): number {
  let lo = 0;
  let hi = map.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid]!.bufStart <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * Wall time shown for buffer time t. Inside a continuous run the clock is held
 * at the next segment's start rather than running past it, so it never steps back.
 */
export function bufToWall(map: TimeMap, t: number): number | null {
  const i = byBuf(map, t);
  if (i < 0) return null;
  const p = map[i]!;
  const offset = Math.min(t, p.bufEnd) - p.bufStart;
  let wall = p.wallStart + offset * 1000;
  const next = map[i + 1];
  if (next && continues(p, next)) wall = Math.min(wall, next.wallStart);
  return wall;
}

/** Buffer time for wall time w, or null when w is not covered by the map (before it, after it, or in a gap). */
export function wallToBuf(map: TimeMap, w: number): number | null {
  let i = -1;
  for (let k = map.length - 1; k >= 0; k--) {
    if (map[k]!.wallStart <= w) {
      i = k;
      break;
    }
  }
  if (i < 0) return null;
  const p = map[i]!;
  const t = p.bufStart + (w - p.wallStart) / 1000;
  if (t <= p.bufEnd) return t;
  const next = map[i + 1];
  // the gap-less sliver between this segment's end and the next one's index start
  if (next && continues(p, next)) return next.bufStart;
  return null;
}

/**
 * timestampOffset that places a segment whose first fragment starts at
 * `fragStart` (seconds, from tfdt): right after the previous placement, or at
 * `base` for the first segment after a reset.
 */
export function offsetFor(map: TimeMap, fragStart: number, base: number): number {
  const last = map[map.length - 1];
  return (last ? last.bufEnd : base) - fragStart;
}

/** Drops placements that end before t, after the buffer before t has been removed. */
export function trimBefore(map: TimeMap, t: number): Placement[] {
  return map.filter((p) => p.bufEnd > t);
}
