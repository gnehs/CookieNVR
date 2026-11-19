import { expect, test } from "bun:test";
import { openDb } from "./db.ts";
import { usageByRoot } from "./recording/store.ts";
import { measureDisks, splitUsage, type FsProbe } from "./storage.ts";
import type { CameraId } from "./types.ts";

const GB = 1024 ** 3;

function probe(disks: Record<string, { dev: number; totalGb: number; freeGb: number }>): FsProbe {
  return {
    dev: (p) => disks[p]!.dev,
    statfs: async (p) => ({ bsize: 4096, blocks: (disks[p]!.totalGb * GB) / 4096, bavail: (disks[p]!.freeGb * GB) / 4096 }),
  };
}

test("錄影與資料目錄在不同硬碟：各自回報容量", async () => {
  const d = await measureDisks("/recordings", "/data", probe({ "/recordings": { dev: 2, totalGb: 8000, freeGb: 6000 }, "/data": { dev: 1, totalGb: 500, freeGb: 300 } }));
  expect(d.disk).toEqual({ path: "/recordings", totalBytes: 8000 * GB, freeBytes: 6000 * GB });
  expect(d.dataDisk).toEqual({ path: "/data", totalBytes: 500 * GB, freeBytes: 300 * GB, sameAsRecordings: false });
});

test("同一個檔案系統只算一顆", async () => {
  const d = await measureDisks("/data/recordings", "/data", probe({ "/data/recordings": { dev: 1, totalGb: 500, freeGb: 300 }, "/data": { dev: 1, totalGb: 500, freeGb: 300 } }));
  expect(d.dataDisk.sameAsRecordings).toBe(true);
});

test("不同掛載但容量與可用空間一樣（例如 Unraid 共享寫進快取池）也算同一顆；可用空間差一點點仍算", async () => {
  const d = await measureDisks("/recordings", "/data", probe({ "/recordings": { dev: 2, totalGb: 500, freeGb: 300 }, "/data": { dev: 1, totalGb: 500, freeGb: 300.01 } }));
  expect(d.dataDisk.sameAsRecordings).toBe(true);
  const other = await measureDisks("/recordings", "/data", probe({ "/recordings": { dev: 2, totalGb: 500, freeGb: 300 }, "/data": { dev: 1, totalGb: 500, freeGb: 290 } }));
  expect(other.dataDisk.sameAsRecordings).toBe(false);
});

test("錄影用量依位置分開：目前位置的算進容量，其他位置另外合計", () => {
  const db = openDb(":memory:");
  const add = (cam: string, path: string, start: number, size: number) =>
    db.query("INSERT INTO segments (camera_id, path, start_ms, end_ms, size) VALUES (?, ?, ?, ?, ?)").run(cam, path, start, start + 60_000, size);
  add("cam1", "/data/recordings/cam1/20261101/000000.mp4", 1, 100);
  add("cam1", "/data/recordings/cam1/20261101/000100.mp4", 2, 50);
  add("cam2", "/data/recordings/cam2/20261101/000000.mp4", 3, 30);
  add("cam1", "/recordings/cam1/20261102/000000.mp4", 10, 7);
  add("cam2", "/recordings/cam2/20261102/000000.mp4", 11, 9);

  expect(splitUsage(usageByRoot(db), "/recordings/")).toEqual({
    usage: [
      { cameraId: "cam1" as CameraId, bytes: 7, oldestMs: 10 },
      { cameraId: "cam2" as CameraId, bytes: 9, oldestMs: 11 },
    ],
    elsewhere: [{ path: "/data/recordings", bytes: 180 }],
  });
});
