import { expect, test } from "bun:test";
import type { CameraId } from "../src/types.ts";
import { estimateDays } from "./retention-estimate.ts";

const NOW = Date.UTC(2026, 10, 19);
const DAY = 86_400_000;
const GB = 1024 ** 3;
const cam = (id: string) => id as CameraId;

test("兩台攝影機每天合計 30 GB，可用 300 GB 加上已錄 60 GB、保留 0：大約 12 天", () => {
  const days = estimateDays(
    {
      usage: [
        { cameraId: cam("a"), bytes: 40 * GB, oldestMs: NOW - 2 * DAY },
        { cameraId: cam("b"), bytes: 20 * GB, oldestMs: NOW - 2 * DAY },
      ],
      disk: { path: "/data", totalBytes: 1000 * GB, freeBytes: 300 * GB },
    },
    0,
    NOW,
  );
  expect(days).toBeCloseTo(12, 5);
});

test("最低剩餘空間要先扣掉", () => {
  const sys = { usage: [{ cameraId: cam("a"), bytes: 10 * GB, oldestMs: NOW - DAY }], disk: { path: "/", totalBytes: 100 * GB, freeBytes: 50 * GB } };
  expect(estimateDays(sys, 10 * GB, NOW)).toBeCloseTo(5, 5);
});

test("沒有錄影或剛開始錄不到一小時時不估算", () => {
  const disk = { path: "/", totalBytes: 100 * GB, freeBytes: 50 * GB };
  expect(estimateDays({ usage: [], disk }, 0, NOW)).toBeNull();
  expect(estimateDays({ usage: [{ cameraId: cam("a"), bytes: GB, oldestMs: NOW - 60_000 }], disk }, 0, NOW)).toBeNull();
});
