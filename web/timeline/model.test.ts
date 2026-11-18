import { expect, test } from "bun:test";
import type { EventDto, SegmentDto } from "../../src/api-types.ts";
import { clusterEvents, eventAt, nextEvent, playableFrom, prevEvent, recordedSpans, tickLabel, ticks, tickSteps } from "./model.ts";

const T = Date.UTC(2026, 10, 18, 4, 0, 0);
const seg = (id: number, start: number, end: number | null): SegmentDto => ({ id, cameraId: "c" as never, startMs: start, endMs: end, size: 1 });
const ev = (id: number, start: number, end: number | null): EventDto => ({
  id, cameraId: "c" as never, source: "pixel", startMs: start, endMs: end, score: 0.3, labels: [], hasThumb: false,
});

// two segments overlapping by 0.6 s, a 1.5 s hiccup (still continuous), a real 5 min gap, then a live one
const segs = [
  seg(1, T, T + 60_600),
  seg(2, T + 60_000, T + 120_000),
  seg(3, T + 121_500, T + 180_000),
  seg(4, T + 480_000, T + 540_000),
  seg(5, T + 540_000, null),
];
const now = T + 560_000;

test("segments merge into spans across sub-2 s seams, and the live tail is marked", () => {
  expect(recordedSpans(segs, now)).toEqual([
    { start: T, end: T + 180_000, liveFrom: null },
    { start: T + 480_000, end: now, liveFrom: T + 540_000 },
  ]);
  expect(recordedSpans([], now)).toEqual([]);
});

test("a click inside a recording plays from there; a click in a gap skips to the next recording", () => {
  expect(playableFrom(segs, T + 30_000, now)).toEqual({ seg: segs[0]!, wall: T + 30_000 });
  expect(playableFrom(segs, T + 60_300, now)).toEqual({ seg: segs[1]!, wall: T + 60_300 });
  expect(playableFrom(segs, T + 200_000, now)).toEqual({ seg: segs[3]!, wall: T + 480_000 });
  expect(playableFrom(segs, T - 5_000, now)).toEqual({ seg: segs[0]!, wall: T });
  expect(playableFrom(segs, T + 550_000, now)).toEqual({ seg: segs[4]!, wall: T + 550_000 });
  expect(playableFrom(segs, now + 1, now)).toBeNull();
});

test("short events get a minimum width, and nearby ones merge at low zoom", () => {
  const events = [ev(1, T, T + 1_000), ev(2, T + 3_000, T + 4_000), ev(3, T + 600_000, null)];
  const view = (msPerPx: number) => ({ start: T - 60_000, end: T + 3_600_000, msPerPx });
  // 10 min view on ~600 px: 1 s per px, 8 px minimum = 8 s, so events 1 and 2 merge
  expect(clusterEvents(events, now, view(1_000), 8, 2)).toEqual([
    { start: T, end: T + 11_000, first: 0, count: 2 },
    { start: T + 600_000, end: T + 608_000, first: 2, count: 1 },
  ]);
  // zoomed in to 100 ms per px they stay apart
  expect(clusterEvents(events, now, view(100), 8, 2).map((c) => c.count)).toEqual([1, 1, 1]);
  // the in-progress event extends to now
  expect(clusterEvents([ev(9, T, null)], T + 120_000, view(10), 8, 2)[0]!.end).toBe(T + 120_000);
});

test("only clusters reaching the view are returned", () => {
  const events = [ev(1, T - 7_200_000, T - 7_100_000), ev(2, T - 100_000, T + 10_000), ev(3, T + 9_000_000, T + 9_001_000)];
  const got = clusterEvents(events, now, { start: T, end: T + 3_600_000, msPerPx: 1_000 }, 8, 2);
  expect(got.map((c) => c.first)).toEqual([1]);
});

test("tick steps keep labels apart at every zoom preset", () => {
  const width = 1000;
  expect(tickSteps(86_400_000 / width, 64)).toEqual({ major: 7_200_000, minor: 900_000 });
  expect(tickSteps(21_600_000 / width, 64)).toEqual({ major: 1_800_000, minor: 300_000 });
  expect(tickSteps(3_600_000 / width, 64)).toEqual({ major: 300_000, minor: 30_000 });
  expect(tickSteps(600_000 / width, 64)).toEqual({ major: 60_000, minor: 5_000 });
});

test("ticks align to local time, not UTC", () => {
  const taipei = () => 8 * 3_600_000;
  const start = Date.UTC(2026, 10, 17, 16, 10); // 00:10 in Taipei
  const got = ticks(start, start + 3 * 3_600_000, 3_600_000, taipei);
  expect(got.map((t) => (t + 8 * 3_600_000) % 86_400_000 / 3_600_000)).toEqual([1, 2, 3]);
  const kolkata = () => 5.5 * 3_600_000;
  expect(ticks(start, start + 3_600_000, 1_800_000, kolkata).every((t) => (t + 5.5 * 3_600_000) % 1_800_000 === 0)).toBe(true);
});

test("tick labels switch to the date at midnight and add seconds when fine", () => {
  const midnight = new Date(2026, 10, 18).getTime();
  expect(tickLabel(midnight, 3_600_000)).toBe("11/18");
  expect(tickLabel(midnight + 9 * 3_600_000 + 30 * 60_000, 1_800_000)).toBe("09:30");
  expect(tickLabel(midnight + 9 * 3_600_000 + 15_000, 5_000)).toBe("09:00:15");
});

test("[ and ] step between events, accounting for the 5 s pre-roll", () => {
  const events = [ev(1, T, T + 1), ev(2, T + 60_000, T + 61_000), ev(3, T + 120_000, T + 121_000)];
  // after jumping to event 2 we sit 5 s before it
  const atTwo = T + 55_000;
  expect(nextEvent(events, atTwo)?.id).toBe(3);
  expect(prevEvent(events, atTwo)?.id).toBe(1);
  // partway into event 2, [ goes back to its start
  expect(prevEvent(events, T + 70_000)?.id).toBe(2);
  expect(nextEvent(events, T + 120_000)).toBeNull();
  expect(prevEvent(events, T - 10_000)).toBeNull();
});

test("the event under the playhead, an in-progress one included", () => {
  const events = [ev(1, T, T + 10_000), ev(2, T + 60_000, null)];
  expect(eventAt(events, T + 5_000, now)?.id).toBe(1);
  expect(eventAt(events, T + 20_000, now)).toBeNull();
  expect(eventAt(events, T + 90_000, now)?.id).toBe(2);
});
