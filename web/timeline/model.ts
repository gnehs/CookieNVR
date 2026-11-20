import { joinList } from "../format.ts";
import { t } from "@lingui/core/macro";
import type { EventDto, SegmentDto } from "../../src/api-types.ts";
import { labelName } from "../detect/label-names.ts";
import { GAP_MS } from "../playback/timemap.ts";

/** Playback starts this long before an event, matching the backend's event buffer. */
export const EVENT_PREROLL_MS = 5_000;

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** A run of recording with no gap longer than GAP_MS; `liveFrom` marks the still-recording tail. */
export interface Span {
  start: number;
  end: number;
  liveFrom: number | null;
}

/** Index end of a segment: its recorded end, or now for one still recording. */
export const segEnd = (s: SegmentDto, now: number) => s.endMs ?? Math.max(now, s.startMs);

/** Merges sorted segments into continuous spans. */
export function recordedSpans(segs: readonly SegmentDto[], now: number): Span[] {
  const spans: Span[] = [];
  for (const s of segs) {
    const end = segEnd(s, now);
    const last = spans[spans.length - 1];
    if (last && s.startMs - last.end <= GAP_MS) {
      last.end = Math.max(last.end, end);
      if (s.endMs === null) last.liveFrom ??= s.startMs;
    } else {
      spans.push({ start: s.startMs, end, liveFrom: s.endMs === null ? s.startMs : null });
    }
  }
  return spans;
}

/**
 * Where playback for wall time w should start: inside the segment covering w,
 * or, when w falls in a gap, at the start of the next recording (dir 1) or just
 * before the end of the previous one (dir -1, for stepping backwards).
 */
export function playableFrom(
  segs: readonly SegmentDto[],
  w: number,
  now: number,
  dir: 1 | -1 = 1,
): { seg: SegmentDto; wall: number } | null {
  let lo = 0;
  let hi = segs.length - 1;
  let i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid]!.startMs <= w) {
      i = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const cur = i >= 0 ? segs[i]! : null;
  if (cur && w < segEnd(cur, now)) return { seg: cur, wall: w };
  if (dir < 0 && cur) return { seg: cur, wall: Math.max(cur.startMs, segEnd(cur, now) - 1_000) };
  const next = segs[i + 1];
  return next ? { seg: next, wall: next.startMs } : null;
}

export interface Cluster {
  start: number;
  /** visual end, at least the minimum clickable extent */
  end: number;
  /** index of the first event in the cluster */
  first: number;
  count: number;
}

/**
 * Groups sorted events whose drawn extents (start..end, at least minPx) come
 * within gapPx of each other at the current zoom, keeping only those that reach the view.
 *
 * "overlap" joins an event to any cluster whose extent it touches, which suits
 * bars on a strip. "anchored" joins only events that start within minPx of the
 * cluster's own start, which suits fixed-size cards: a long run of events then
 * becomes a series of cards rather than one card for the whole run.
 */
export function clusterEvents(
  events: readonly EventDto[],
  now: number,
  view: { start: number; end: number; msPerPx: number },
  minPx: number,
  gapPx: number,
  mode: "overlap" | "anchored" = "overlap",
): Cluster[] {
  const minMs = minPx * view.msPerPx;
  const gapMs = gapPx * view.msPerPx;
  const out: Cluster[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.startMs > view.end) break;
    const end = Math.max(e.endMs ?? now, e.startMs + minMs);
    if (end < view.start) continue;
    const last = out[out.length - 1];
    const reach = last ? (mode === "overlap" ? last.end : last.start + minMs) + gapMs : 0;
    if (last && e.startMs <= reach) {
      last.end = Math.max(last.end, end);
      last.count++;
    } else {
      out.push({ start: e.startMs, end, first: i, count: 1 });
    }
  }
  return out;
}

const STEPS = [SEC, 2 * SEC, 5 * SEC, 10 * SEC, 15 * SEC, 30 * SEC, MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR];

/** Major (labelled) and minor tick steps so labels sit at least labelPx apart and minor ticks minorPx apart. */
export function tickSteps(msPerPx: number, labelPx: number, minorPx = 7): { major: number; minor: number } {
  const major = STEPS.find((s) => s / msPerPx >= labelPx) ?? STEPS[STEPS.length - 1]!;
  const minor = STEPS.find((s) => s < major && major % s === 0 && s / msPerPx >= minorPx) ?? major;
  return { major, minor };
}

/** Local-time-aligned tick positions in [start, end]; offsetAt gives the zone offset (ms east of UTC) at an instant. */
export function ticks(start: number, end: number, step: number, offsetAt: (ms: number) => number): number[] {
  const off = offsetAt(start);
  const out: number[] = [];
  for (let t = Math.ceil((start + off) / step) * step - off; t <= end; t += step) out.push(t);
  return out;
}

export const browserOffset = (ms: number) => -new Date(ms).getTimezoneOffset() * MIN;

const pad = (n: number) => String(n).padStart(2, "0");

export function tickLabel(ms: number, step: number): string {
  const d = new Date(ms);
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) return `${d.getMonth() + 1}/${d.getDate()}`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return step < MIN ? `${hm}:${pad(d.getSeconds())}` : hm;
}

/** The event to jump to for `]`: the first that starts after the current one (allowing for the pre-roll). */
export function nextEvent(events: readonly EventDto[], wall: number): EventDto | null {
  const ref = wall + EVENT_PREROLL_MS;
  return events.find((e) => e.startMs > ref + 500) ?? null;
}

/** The event to jump to for `[`: the last that starts clearly before the current position. */
export function prevEvent(events: readonly EventDto[], wall: number): EventDto | null {
  const ref = wall + EVENT_PREROLL_MS;
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.startMs < ref - 2_000) return events[i]!;
  return null;
}

/** The event covering wall time w, if any. */
export function eventAt(events: readonly EventDto[], w: number, now: number): EventDto | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.startMs <= w && w <= (e.endMs ?? now)) return e;
  }
  return null;
}

/** 清單項目之間的分隔：英文「, 」，中日文「、」 */

/** 事件的標題：看到了什麼；沒有類別就是「動作」 */
export const labelText = (labels: readonly string[]) => (labels.length ? joinList([...new Set(labels.map((l) => labelName(l)))]) : t({ message: "Motion", context: "event without objects" }));
