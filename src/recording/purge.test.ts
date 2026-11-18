import { expect, test } from "bun:test";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openDb } from "../db.ts";
import type { CameraId } from "../types.ts";
import { createIndexer } from "./indexer.ts";
import { purgeCamera, purgeOrphans } from "./purge.ts";
import { segmentPath } from "./layout.ts";
import { tempSettings, writeSegment } from "./test-helpers.ts";

const exists = (path: string) => stat(path).then(() => true, () => false);
const T = Date.UTC(2026, 10, 18, 12, 0);

async function setup() {
  const settings = await tempSettings();
  const dataDir = await mkdtemp(join(tmpdir(), "cookienvr-data-"));
  const db = openDb(":memory:");
  const indexer = createIndexer({ db, settings: () => settings });
  const deps = { db, storagePath: () => settings.storagePath, dataDir };
  const addEvent = async (cameraId: string, withThumb = true) => {
    const { lastInsertRowid } = db
      .query(`INSERT INTO events (camera_id, source, start_ms, has_thumb) VALUES (?, 'pixel', ?, ?)`)
      .run(cameraId, T, withThumb ? 1 : 0);
    const path = join(dataDir, "thumbs", `${lastInsertRowid}.jpg`);
    await mkdir(join(dataDir, "thumbs"), { recursive: true });
    await writeFile(path, "jpg");
    return path;
  };
  const count = (table: string, cameraId: string) =>
    (db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE camera_id = ?`).get(cameraId) as { n: number }).n;
  return { settings, dataDir, db, indexer, deps, addEvent, count };
}

test("purges only the named camera: files, directory, segment rows, events and thumbnails", async () => {
  const { settings, indexer, deps, addEvent, count } = await setup();
  const a1 = await writeSegment(settings, "cama", T, 10, T + 5000);
  const a2 = await writeSegment(settings, "cama", T + 60_000, 20, T + 65_000);
  const b1 = await writeSegment(settings, "camb", T, 7, T + 5000);
  await indexer.reconcile(T + 3600_000);
  const thumbA = await addEvent("cama");
  const thumbB = await addEvent("camb");

  const result = await purgeCamera(deps, "cama" as CameraId);

  expect(result).toEqual({ segments: 2, events: 1, bytes: 30 });
  expect(await exists(a1)).toBe(false);
  expect(await exists(a2)).toBe(false);
  expect(await exists(join(settings.storagePath, "cama"))).toBe(false);
  expect(await exists(thumbA)).toBe(false);
  expect(count("segments", "cama")).toBe(0);
  expect(count("events", "cama")).toBe(0);

  expect(await exists(b1)).toBe(true);
  expect(await exists(thumbB)).toBe(true);
  expect(count("segments", "camb")).toBe(1);
  expect(count("events", "camb")).toBe(1);
});

test("running it again changes nothing and does not fail", async () => {
  const { settings, indexer, deps } = await setup();
  await writeSegment(settings, "cama", T, 10, T + 5000);
  await indexer.reconcile(T + 3600_000);
  await purgeCamera(deps, "cama" as CameraId);
  expect(await purgeCamera(deps, "cama" as CameraId)).toEqual({ segments: 0, events: 0, bytes: 0 });
});

test("a missing file is not an error and its row still goes", async () => {
  const { settings, db, deps, count } = await setup();
  const path = segmentPath(settings.storagePath, "cama", T);
  db.query(`INSERT INTO segments (camera_id, path, start_ms, end_ms, size) VALUES ('cama', ?, ?, ?, 5)`).run(path, T, T + 1000);
  expect((await purgeCamera(deps, "cama" as CameraId)).segments).toBe(1);
  expect(count("segments", "cama")).toBe(0);
});

test("files under a previous storage path are deleted through their row path", async () => {
  const { settings, indexer, db, deps } = await setup();
  const old = { ...settings, storagePath: await mkdtemp(join(tmpdir(), "cookienvr-old-")) };
  const oldFile = await writeSegment(old, "cama", T, 9, T + 5000);
  const oldOther = await writeSegment(old, "camb", T, 9, T + 5000);
  const current = await writeSegment(settings, "cama", T + 60_000, 4, T + 65_000);
  const oldIndexer = createIndexer({ db, settings: () => old });
  await oldIndexer.reconcile(T + 3600_000);
  await indexer.reconcile(T + 3600_000);
  // reconcile on the new root keeps rows whose files still exist elsewhere
  expect((db.query(`SELECT COUNT(*) AS n FROM segments WHERE camera_id = 'cama'`).get() as { n: number }).n).toBe(2);

  const result = await purgeCamera(deps, "cama" as CameraId);

  expect(result.segments).toBe(2);
  expect(await exists(oldFile)).toBe(false);
  expect(await exists(current)).toBe(false);
  expect(await exists(join(old.storagePath, "cama"))).toBe(false);
  expect(await exists(oldOther)).toBe(true);
});

test("a row whose path points outside the camera's layout is dropped but never deleted from disk", async () => {
  const { db, deps, count } = await setup();
  const victimDir = await mkdtemp(join(tmpdir(), "cookienvr-victim-"));
  const victims = [
    join(victimDir, "precious.mp4"),
    join(victimDir, "camb", "20261118", "120000.mp4"),
    `${victimDir}/cama/../camb/20261118/120000.mp4`,
    "relative/cama/20261118/120000.mp4",
  ];
  for (const [i, p] of victims.entries()) {
    if (p.startsWith("/")) {
      await mkdir(dirname(resolve(p)), { recursive: true });
      await writeFile(resolve(p), "x");
    }
    db.query(`INSERT INTO segments (camera_id, path, start_ms, size) VALUES ('cama', ?, ?, 1)`).run(p, T + i);
  }
  await purgeCamera(deps, "cama" as CameraId);
  expect(count("segments", "cama")).toBe(0);
  for (const p of victims.slice(0, 3)) expect(await exists(resolve(p))).toBe(true);
});

test("unsafe camera ids are refused", async () => {
  const { deps } = await setup();
  for (const id of ["", ".", "..", "../x", "a/b"]) {
    await expect(purgeCamera(deps, id as CameraId)).rejects.toThrow();
  }
});

test("purgeOrphans removes only cameras that are not live", async () => {
  const { settings, indexer, deps, addEvent, count } = await setup();
  const live = await writeSegment(settings, "live", T, 10, T + 5000);
  const gone = await writeSegment(settings, "gone", T, 10, T + 5000);
  await indexer.reconcile(T + 3600_000);
  const goneThumb = await addEvent("gone2");
  const result = await purgeOrphans(deps, (id) => id === "live");
  expect(result).toEqual({ segments: 1, events: 1, bytes: 10 });
  expect(await exists(live)).toBe(true);
  expect(await exists(gone)).toBe(false);
  expect(await exists(goneThumb)).toBe(false);
  expect(count("segments", "live")).toBe(1);
  expect(count("segments", "gone")).toBe(0);
  expect(await purgeOrphans(deps, (id) => id === "live")).toEqual({ segments: 0, events: 0, bytes: 0 });
});

test("a scan queued behind a purge cannot bring deleted recordings back", async () => {
  const { settings, indexer, deps, db } = await setup();
  await writeSegment(settings, "cama", T, 10, T + 5000);
  await indexer.reconcile(T + 3600_000);
  const scan = indexer.scanOnce(T + 3600_000);
  await indexer.exclusive(() => purgeCamera(deps, "cama" as CameraId));
  await indexer.scanOnce(T + 3600_000);
  await scan;
  expect((db.query(`SELECT COUNT(*) AS n FROM segments`).get() as { n: number }).n).toBe(0);
});
