import { expect, test } from "bun:test";
import { exists, readdir } from "node:fs/promises";
import { join } from "node:path";
import { openDb } from "../db.ts";
import type { Settings } from "../types.ts";
import { createIndexer } from "./indexer.ts";
import { createRetention } from "./retention.ts";
import { allSegments, usageByCamera } from "./store.ts";
import { camera, tempSettings, writeSegment } from "./test-helpers.ts";
import { ensureDayDirs } from "./worker.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const plenty = async () => Number.MAX_SAFE_INTEGER;

async function setup(segmentsDaysAgo: number[], freeBytes = plenty) {
  const settings: Settings = await tempSettings();
  const db = openDb(":memory:");
  const paths: string[] = [];
  for (const ago of segmentsDaysAgo) {
    const start = NOW - ago * DAY;
    paths.push(await writeSegment(settings, "cam1", start, 1000, start + 60_000));
  }
  await createIndexer({ db, settings: () => settings }).reconcile(NOW);
  const dataDir = settings.storagePath + "-data";
  const retention = createRetention({ db, settings: () => settings, freeBytes, dataDir });
  const remaining = () => allSegments(db).map((s) => s.path).sort();
  const addEvent = (startMs: number, endMs: number | null) =>
    db.query("INSERT INTO events (camera_id, source, start_ms, end_ms) VALUES ('cam1', 'pixel', ?, ?)").run(startMs, endMs);
  return { settings, db, paths, retention, remaining, addEvent, dataDir };
}

test("continuous recording older than 7 days is deleted from disk and index", async () => {
  const { paths, retention, remaining } = await setup([8, 6]);
  expect(await retention.runOnce(NOW)).toEqual({ deleted: 1, freedBytes: 1000, events: 0 });
  expect(remaining()).toEqual([paths[1]!]);
  expect(await exists(paths[0]!)).toBe(false);
  expect(await retention.runOnce(NOW)).toEqual({ deleted: 0, freedBytes: 0, events: 0 });
});

test("segments overlapping an event (with 5 s buffer) are kept for 30 days", async () => {
  const { paths, retention, remaining, addEvent } = await setup([31, 20, 10]);
  const segStart = (i: number) => NOW - [31, 20, 10][i]! * DAY;
  addEvent(segStart(0) + 10_000, segStart(0) + 20_000);
  // Event starts 3 s after segment 1 ends: only the buffer makes them overlap.
  addEvent(segStart(1) + 63_000, segStart(1) + 70_000);
  // Event starts 10 s after segment 2 ends: outside the buffer.
  addEvent(segStart(2) + 70_000, segStart(2) + 80_000);
  await retention.runOnce(NOW);
  expect(remaining()).toEqual([paths[1]!]);
});

test("an ongoing event (no end yet) protects segments after its start", async () => {
  const { paths, retention, remaining, addEvent } = await setup([10]);
  addEvent(NOW - 11 * DAY, null);
  await retention.runOnce(NOW);
  expect(remaining()).toEqual([paths[0]!]);
});

test("events past the event retention are deleted with their thumbnails; open ones stay", async () => {
  const { db, retention, addEvent, dataDir } = await setup([]);
  addEvent(NOW - 31 * DAY, NOW - 31 * DAY + 5_000);
  addEvent(NOW - 29 * DAY, NOW - 29 * DAY + 5_000);
  addEvent(NOW - 40 * DAY, null);
  const ids = (db.query("SELECT id FROM events ORDER BY id").all() as { id: number }[]).map((r) => r.id);
  for (const id of ids) await Bun.write(join(dataDir, "thumbs", `${id}.jpg`), "jpeg");
  expect((await retention.runOnce(NOW)).events).toBe(1);
  expect((db.query("SELECT id FROM events ORDER BY id").all() as { id: number }[]).map((r) => r.id)).toEqual([ids[1]!, ids[2]!]);
  expect(await exists(join(dataDir, "thumbs", `${ids[0]}.jpg`))).toBe(false);
  expect(await exists(join(dataDir, "thumbs", `${ids[1]}.jpg`))).toBe(true);
});

test("low disk space evicts the oldest segments regardless of events, never the recording one", async () => {
  let free = 0;
  const { settings, db, paths, retention, remaining, addEvent } = await setup([3, 2, 1], async () => free);
  addEvent(NOW - 3 * DAY, NOW - 3 * DAY + 30_000);
  const recording = await writeSegment(settings, "cam1", NOW - 30_000, 500, NOW - 1_000);
  await createIndexer({ db, settings: () => settings }).scanOnce(NOW);

  free = settings.retention.minFreeBytes - 1500;
  expect(await retention.runOnce(NOW)).toEqual({ deleted: 2, freedBytes: 2000, events: 0 });
  expect(remaining()).toEqual([paths[2]!, recording].sort());

  free = 0;
  await retention.runOnce(NOW);
  expect(remaining()).toEqual([recording]);
  expect(usageByCamera(db)).toEqual([{ cameraId: "cam1" as never, bytes: 500, oldestMs: NOW - 30_000 }]);
});

test("empty past day directories are removed but today's and tomorrow's are kept", async () => {
  const { settings, retention } = await setup([8]);
  const cam = join(settings.storagePath, "cam1");
  await ensureDayDirs([camera("cam1")], settings, NOW);
  await retention.runOnce(NOW);
  expect((await readdir(cam)).sort()).toEqual(["20261118", "20261119"]);
});
