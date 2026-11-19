import { expect, test } from "bun:test";
import { camerasSupported, loadSample, verdict } from "./capacity.ts";

test("capacity keeps headroom: half of a CPU, 80% of a GPU", () => {
  expect(camerasSupported(80, "cpu", 2)).toBe(20);
  expect(camerasSupported(80, "nvidia", 2)).toBe(32);
  expect(camerasSupported(3, "cpu", 2)).toBe(0);
  expect(verdict(20, "cpu", 2, 6)).toEqual({ state: "partial", supported: 5, cameras: 6 });
  expect(verdict(20, "cpu", 1, 6)).toEqual({ state: "enough", supported: 10, cameras: 6 });
});

test("the live load is the last minute's rate and the last five minutes' drop ratio", () => {
  const now = 1_000_000;
  const processed = Array.from({ length: 120 }, (_, i) => now - i * 500);
  expect(loadSample(processed, [], now)).toEqual({ rateFps: 2, dropRatio: 0 });
  expect(loadSample(processed.slice(0, 10), [now - 1000, now - 2000], now).dropRatio).toBeNull();
  expect(loadSample(processed, Array.from({ length: 30 }, (_, i) => now - i * 1000), now).dropRatio).toBeCloseTo(30 / 150);
});
