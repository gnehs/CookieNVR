import { expect, test } from "bun:test";
import { bufToWall, offsetFor, trimBefore, wallToBuf, type Placement } from "./timemap.ts";

const T = Date.UTC(2026, 10, 18, 12, 0, 0);

/**
 * Three segments as measured on a real camera: index starts 60 s apart, but the
 * first file holds 61.4 s of video and the second 60.3 s, so in the buffer each
 * one is chained onto the end of the previous. Then a real gap of 5 minutes.
 */
const map: Placement[] = [
  { segId: 1, wallStart: T, bufStart: 100, bufEnd: 161.4 },
  { segId: 2, wallStart: T + 60_000, bufStart: 161.4, bufEnd: 221.7 },
  { segId: 3, wallStart: T + 120_000, bufStart: 221.7, bufEnd: 281.7 },
  { segId: 4, wallStart: T + 480_000, bufStart: 281.7, bufEnd: 341.7 },
];

test("buffer time maps to wall time inside a segment", () => {
  expect(bufToWall(map, 100)).toBe(T);
  expect(bufToWall(map, 130.5)).toBe(T + 30_500);
  expect(bufToWall(map, 161.4)).toBe(T + 60_000);
  expect(bufToWall(map, 191.4)).toBe(T + 90_000);
});

test("the clock holds at the next segment's start while the overlap plays", () => {
  expect(bufToWall(map, 160.5)).toBe(T + 60_000);
  expect(bufToWall(map, 159.9)).toBe(T + 59_900);
  const samples = Array.from({ length: 2400 }, (_, i) => bufToWall(map, 100 + i * 0.1)!);
  for (let i = 1; i < samples.length; i++) expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
});

test("across a real gap the clock jumps forward", () => {
  expect(bufToWall(map, 281.6)).toBeCloseTo(T + 179_900, 5);
  expect(bufToWall(map, 281.7)).toBe(T + 480_000);
});

test("outside the map there is no wall time; past the end it holds at the end", () => {
  expect(bufToWall(map, 99)).toBeNull();
  expect(bufToWall(map, 400)).toBe(T + 480_000 + 60_000);
  expect(bufToWall([], 0)).toBeNull();
});

test("wall time maps back into the buffer", () => {
  expect(wallToBuf(map, T)).toBe(100);
  expect(wallToBuf(map, T + 30_000)).toBe(130);
  // 60.5 s belongs to segment 2 by its index time
  expect(wallToBuf(map, T + 60_500)).toBeCloseTo(161.9, 9);
  expect(wallToBuf(map, T + 480_000 + 10_000)).toBeCloseTo(291.7, 9);
});

test("wall times in a gap, before or after the map are not buffered", () => {
  expect(wallToBuf(map, T - 1)).toBeNull();
  expect(wallToBuf(map, T + 300_000)).toBeNull();
  expect(wallToBuf(map, T + 600_000)).toBeNull();
});

test("a segment shorter than its index span hands over to the next one", () => {
  const short: Placement[] = [
    { segId: 1, wallStart: T, bufStart: 0, bufEnd: 59.4 },
    { segId: 2, wallStart: T + 60_000, bufStart: 59.4, bufEnd: 119.4 },
  ];
  expect(wallToBuf(short, T + 59_700)).toBe(59.4);
  expect(bufToWall(short, 59.4)).toBe(T + 60_000);
});

test("each segment is chained to the end of the previous, whatever its own start time", () => {
  expect(offsetFor([], 0, 10)).toBe(10);
  expect(offsetFor([], 0.04, 10)).toBeCloseTo(9.96, 9);
  expect(offsetFor(map, 0, 0)).toBe(341.7);
  expect(offsetFor(map, 0.5, 0)).toBeCloseTo(341.2, 9);
});

test("trimming drops only placements that ended before the cut", () => {
  expect(trimBefore(map, 200).map((p) => p.segId)).toEqual([2, 3, 4]);
  expect(trimBefore(map, 161.4).map((p) => p.segId)).toEqual([2, 3, 4]);
  expect(trimBefore(map, 50).map((p) => p.segId)).toEqual([1, 2, 3, 4]);
});
