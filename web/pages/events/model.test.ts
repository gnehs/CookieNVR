import { describe, expect, test } from "bun:test";
import type { EventDto } from "../../../src/api-types.ts";
import type { CameraId } from "../../../src/types.ts";
import { dayTitle, groupByDay, mergeEvents, playbackSearch } from "./model.ts";

const ev = (id: number, startMs: number, endMs: number | null = startMs + 5_000): EventDto => ({ id, cameraId: "c1" as CameraId, source: "pixel", startMs, endMs, score: 0.1, labels: [], hasThumb: true });
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("事件清單", () => {
  test("合併後由新到舊、同一筆以新的為準", () => {
    const merged = mergeEvents([ev(1, 100, null), ev(2, 50)], [ev(1, 100, 900), ev(3, 200)]);
    expect(merged.map((e) => e.id)).toEqual([3, 1, 2]);
    expect(merged[1]!.endMs).toBe(900);
  });

  test("依瀏覽器時區分天", () => {
    const groups = groupByDay([ev(1, at(2026, 11, 19, 0, 10)), ev(2, at(2026, 11, 18, 23, 50)), ev(3, at(2026, 11, 18, 8))]);
    expect(groups.map((g) => [g.key, g.events.map((e) => e.id)])).toEqual([["2026-11-19", [1]], ["2026-11-18", [2, 3]]]);
  });

  test("今天、昨天用口語，其他寫日期與星期", () => {
    const now = at(2026, 11, 19, 9);
    expect(dayTitle("2026-11-19", now)).toBe("Today");
    expect(dayTitle("2026-11-18", now)).toBe("Yesterday");
    expect(dayTitle("2026-11-16", now)).toBe("Mon, 11/16");
    expect(dayTitle("2025-12-31", now)).toBe("Wed, 12/31/2025");
  });

  test("點事件從開始前 5 秒回放，日期用瀏覽器時區", () => {
    const start = at(2026, 11, 18, 0, 0) + 2_000;
    expect(playbackSearch({ startMs: start })).toEqual({ date: "2026-11-18", t: start - 5_000 });
  });
});
