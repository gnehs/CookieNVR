import { describe, expect, test } from "bun:test";
import { MAX_EXPORT_MS, planExport, type PlanSegment } from "./plan.ts";

const T = 1_000_000_000_000;
const seg = (id: number, startS: number, endS: number | null, size = 6_000): PlanSegment => ({
  id,
  startMs: T + startS * 1000,
  endMs: endS === null ? null : T + endS * 1000,
  size,
});
const NOW = T + 10 * 60_000;

describe("planExport", () => {
  test("a range inside one segment trims both ends and estimates its share of the bytes", () => {
    const plan = planExport([seg(1, 0, 60)], T + 10_000, T + 40_000, NOW);
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.parts).toEqual([{ segmentId: 1, open: false, inpointMs: 10_000, outpointMs: 40_000, coveredMs: 30_000, bytes: 3_000 }]);
    expect(plan.durationMs).toBe(30_000);
    expect(plan.estimatedBytes).toBe(3_000);
  });

  test("whole middle segments are kept untrimmed and a gap between segments is simply skipped", () => {
    const segs = [seg(1, 0, 60), seg(2, 60, 120), seg(3, 200, 260)];
    const plan = planExport(segs, T + 30_000, T + 230_000, NOW);
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.parts.map((p) => [p.segmentId, p.inpointMs, p.outpointMs])).toEqual([
      [1, 30_000, null],
      [2, 0, null],
      [3, 0, 30_000],
    ]);
    expect(plan.durationMs).toBe(30_000 + 60_000 + 30_000);
  });

  test("a range reaching into the open segment takes it as far as it is written", () => {
    const plan = planExport([seg(1, 0, 60), seg(2, 60, null, 4_000)], T + 50_000, T + 400_000, T + 120_000);
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.includesRecording).toBe(true);
    expect(plan.endMs).toBe(T + 120_000);
    expect(plan.parts[1]).toMatchObject({ segmentId: 2, open: true, outpointMs: null, coveredMs: 60_000 });
  });

  test("an end in the future is pulled back to now", () => {
    const plan = planExport([seg(1, 0, null)], T + 100_000, T + 3_600_000, T + 130_000);
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.endMs).toBe(T + 130_000);
    expect(plan.durationMs).toBe(30_000);
  });

  test("refuses a range without recordings, too long, or too short", () => {
    expect(planExport([seg(1, 0, 60)], T + 100_000, T + 160_000, NOW)).toMatchObject({ ok: false, reason: "empty" });
    expect(planExport([seg(1, 0, 60)], T, T + MAX_EXPORT_MS + 1, T + 3 * MAX_EXPORT_MS)).toMatchObject({ ok: false, reason: "too-long" });
    expect(planExport([seg(1, 0, 60)], T, T + MAX_EXPORT_MS, T + 3 * MAX_EXPORT_MS)).toMatchObject({ ok: true });
    expect(planExport([seg(1, 0, 60)], T + 5_000, T + 5_400, NOW)).toMatchObject({ ok: false, reason: "invalid" });
    expect(planExport([seg(1, 0, 60)], T + 9_000_000, T + 9_100_000, NOW)).toMatchObject({ ok: false, reason: "invalid" });
  });
});
