import { expect, test } from "bun:test";
import { dayKey, parseSegmentPath, segmentPath, strftimePattern } from "./layout.ts";
import type { CameraId } from "../types.ts";

test("segment path is UTC and round-trips to the same start time", () => {
  const start = Date.UTC(2026, 0, 2, 3, 4, 5);
  const path = segmentPath("/rec", "cam", start);
  expect(path).toBe("/rec/cam/20260102/030405.mp4");
  expect(parseSegmentPath(path)).toEqual({ cameraId: "cam" as CameraId, startMs: start });
});

test("parse rejects names that are not segments", () => {
  expect(parseSegmentPath("/rec/cam/20260102/030405.mp4.tmp")).toBeNull();
  expect(parseSegmentPath("/rec/cam/20260102/250000.mp4")).toBeNull();
  expect(parseSegmentPath("/rec/cam/20260230/000000.mp4")).toBeNull();
  expect(parseSegmentPath("/rec/cam/2026-01-02/000000.mp4")).toBeNull();
});

test("day key crosses at UTC midnight", () => {
  expect<string>(dayKey(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe("20261231");
  expect<string>(dayKey(Date.UTC(2027, 0, 1))).toBe("20270101");
});

test("strftime pattern escapes % in the storage path", () => {
  expect(strftimePattern("/a%b", "cam" as CameraId)).toBe("/a%%b/cam/%Y%m%d/%H%M%S.mp4");
});
