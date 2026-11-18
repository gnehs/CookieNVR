import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { openDb } from "../db.ts";
import { createIndexer } from "./indexer.ts";
import { allSegments } from "./store.ts";
import { tempSettings, writeSegment } from "./test-helpers.ts";

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const rows = (db: ReturnType<typeof openDb>) =>
  allSegments(db)
    .map(({ id: _, ...s }) => s)
    .sort((a, b) => a.cameraId.localeCompare(b.cameraId) || a.startMs - b.startMs);

test("a new file is indexed as recording and closed when a newer one appears", async () => {
  const settings = await tempSettings();
  const db = openDb(":memory:");
  const indexer = createIndexer({ db, settings: () => settings });

  const first = await writeSegment(settings, "cam1", T0, 100, T0 + 20_000);
  await indexer.scanOnce(T0 + 21_000);
  expect(rows(db)).toEqual([{ cameraId: "cam1" as never, path: first, startMs: T0, endMs: null, size: 100 }]);

  await writeSegment(settings, "cam1", T0, 300, T0 + 59_500);
  const second = await writeSegment(settings, "cam1", T0 + 60_000, 50, T0 + 61_000);
  await indexer.scanOnce(T0 + 62_000);
  await indexer.scanOnce(T0 + 62_000);
  expect(rows(db)).toEqual([
    { cameraId: "cam1" as never, path: first, startMs: T0, endMs: T0 + 59_500, size: 300 },
    { cameraId: "cam1" as never, path: second, startMs: T0 + 60_000, endMs: null, size: 50 },
  ]);
});

test("closing across UTC midnight uses yesterday's directory", async () => {
  const settings = await tempSettings();
  const db = openDb(":memory:");
  const indexer = createIndexer({ db, settings: () => settings });
  const midnight = Date.UTC(2026, 10, 19);
  await writeSegment(settings, "cam1", midnight - 60_000, 10, midnight - 1);
  await writeSegment(settings, "cam1", midnight, 10, midnight + 5_000);
  await indexer.scanOnce(midnight + 6_000);
  expect(rows(db).map((s) => s.endMs)).toEqual([midnight - 1, null]);
});

test("the newest file is closed once ffmpeg has clearly stopped writing it", async () => {
  const settings = await tempSettings();
  const db = openDb(":memory:");
  const indexer = createIndexer({ db, settings: () => settings });
  await writeSegment(settings, "cam1", T0, 10, T0 + 30_000);
  await indexer.scanOnce(T0 + 60_000);
  expect(rows(db)[0]!.endMs).toBeNull();
  await indexer.scanOnce(T0 + 30_000 + 91_000);
  expect(rows(db)[0]!.endMs).toBe(T0 + 30_000);
});

test("cameras are tracked independently", async () => {
  const settings = await tempSettings();
  const db = openDb(":memory:");
  const indexer = createIndexer({ db, settings: () => settings });
  await writeSegment(settings, "a", T0, 1, T0 + 5_000);
  await writeSegment(settings, "b", T0 - 60_000, 1, T0 - 1_000);
  await writeSegment(settings, "b", T0, 1, T0 + 5_000);
  await indexer.scanOnce(T0 + 6_000);
  expect(rows(db).map((s): unknown[] => [s.cameraId, s.endMs])).toEqual([
    ["a", null],
    ["b", T0 - 1_000],
    ["b", null],
  ]);
});

test("reconcile registers files on disk and drops rows whose file is gone, idempotently", async () => {
  const settings = await tempSettings();
  const db = openDb(":memory:");
  const indexer = createIndexer({ db, settings: () => settings });
  const old = await writeSegment(settings, "cam1", T0 - 10 * 86_400_000, 10, T0 - 10 * 86_400_000 + 60_000);
  const gone = await writeSegment(settings, "cam1", T0 - 120_000, 10, T0 - 60_000);
  await indexer.scanOnce(T0 - 30_000);
  await rm(gone);
  const last = await writeSegment(settings, "cam1", T0, 20, T0 + 1_000);

  await indexer.reconcile(T0 + 2_000);
  await indexer.reconcile(T0 + 2_000);
  expect(rows(db)).toEqual([
    { cameraId: "cam1" as never, path: old, startMs: T0 - 10 * 86_400_000, endMs: T0 - 10 * 86_400_000 + 60_000, size: 10 },
    { cameraId: "cam1" as never, path: last, startMs: T0, endMs: null, size: 20 },
  ]);
});

test("files that are not segments are ignored", async () => {
  const settings = await tempSettings();
  const db = openDb(":memory:");
  const indexer = createIndexer({ db, settings: () => settings });
  const path = await writeSegment(settings, "cam1", T0, 1, T0);
  await Bun.write(path.replace(".mp4", ".txt"), "x");
  await indexer.reconcile(T0);
  expect(rows(db).length).toBe(1);
});
