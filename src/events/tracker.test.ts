import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.ts";
import type { CameraId } from "../types.ts";
import { thumbPath } from "./paths.ts";
import type { EventBoxDto } from "../api-types.ts";
import { purgeCamera } from "../recording/purge.ts";
import { createRetention } from "../recording/retention.ts";
import { eventBoxes, getEvent, insertEvent, insertEventBoxes } from "./store.ts";
import { createEventTracker, type EventNotice, type ObjectFrame } from "./tracker.ts";

const cam = "cam1" as CameraId;
const px = (at: number, score: number) => ({ type: "pixel", at, score, motion: true }) as const;
const person: EventBoxDto = { label: "person", score: 0.8, box: [0.1, 0.2, 0.3, 0.6] };
const frame = (bytes: number[], boxes: EventBoxDto[]): ObjectFrame => ({ jpeg: new Uint8Array(bytes), boxes });

const MAX_EVENT_MS = 10 * 60_000;

async function setup(db = openDb(":memory:"), now = () => 100_000, filterWindow?: () => number | null, maxEventMs?: (id: CameraId) => number) {
  const dataDir = await mkdtemp(join(tmpdir(), "cookienvr-tracker-"));
  const tracker = createEventTracker({ db, dataDir, now, filterWindow, maxEventMs });
  const notices: EventNotice[] = [];
  tracker.subscribe((n) => notices.push(n));
  return { db, dataDir, tracker, notices };
}

test("an event is recorded, gets the next snapshot as thumbnail and is announced", async () => {
  const { tracker, notices, dataDir, db } = await setup();
  tracker.signal(cam, px(0, 0.02), 10_000);
  tracker.signal(cam, px(200, 0.03), 10_000);
  const event = tracker.activeFor(cam)!;
  expect(event).toMatchObject({ cameraId: cam, source: "pixel", startMs: 0, endMs: null, hasThumb: false });
  tracker.offerJpeg(cam, new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]));
  await Bun.sleep(20);
  expect(await Bun.file(thumbPath(dataDir, event.id)).bytes()).toEqual(new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]));
  expect(getEvent(db, event.id)!.hasThumb).toBe(true);
  // 只有分數創新高才換縮圖
  tracker.offerJpeg(cam, new Uint8Array([9]));
  await Bun.sleep(20);
  expect((await Bun.file(thumbPath(dataDir, event.id)).bytes())[0]).toBe(0xff);
  tracker.signal(cam, { type: "tick", at: 20_000 }, 10_000);
  expect(tracker.activeFor(cam)).toBeNull();
  expect(notices.map((n) => [n.phase, n.event.endMs])).toEqual([
    ["start", null],
    ["update", null],
    ["end", 200],
  ]);
  expect(tracker.active()).toEqual([]);
});

test("a listener that throws does not break recording", async () => {
  const { tracker } = await setup();
  tracker.subscribe(() => {
    throw new Error("boom");
  });
  tracker.signal(cam, px(0, 0.02), 10_000);
  tracker.signal(cam, px(200, 0.02), 10_000);
  expect(tracker.activeFor(cam)).not.toBeNull();
});

test("events left open by a crash are closed on start, capped at the maximum length", async () => {
  const db = openDb(":memory:");
  const recent = insertEvent(db, { cameraId: cam, source: "pixel", startMs: 95_000, score: 0.1, labels: [] });
  const old = insertEvent(db, { cameraId: cam, source: "onvif", startMs: 1_000, score: 0, labels: [] });
  await setup(db, () => 100_000 + MAX_EVENT_MS);
  expect(getEvent(db, recent.id)!.endMs).toBe(95_000 + MAX_EVENT_MS);
  expect(getEvent(db, old.id)!.endMs).toBe(1_000 + MAX_EVENT_MS);
});

test("crash leftovers are capped at each camera's own maximum length", async () => {
  const db = openDb(":memory:");
  const other = "cam2" as CameraId;
  const short = insertEvent(db, { cameraId: other, source: "pixel", startMs: 1_000, score: 0, labels: [] });
  const long = insertEvent(db, { cameraId: cam, source: "pixel", startMs: 1_000, score: 0, labels: [] });
  await setup(db, () => 10_000_000, undefined, (id) => (id === other ? 60_000 : 30 * 60_000));
  expect(getEvent(db, short.id)!.endMs).toBe(61_000);
  expect(getEvent(db, long.id)!.endMs).toBe(1_000 + 30 * 60_000);
});

test("continuous motion is split at the camera's maximum length", async () => {
  const { tracker, notices } = await setup(undefined, undefined, undefined, () => 60_000);
  for (let t = 0; t <= 65_000; t += 1_000) {
    tracker.signal(cam, px(t, 0.02), 10_000);
    tracker.signal(cam, px(t + 200, 0.02), 10_000);
    tracker.signal(cam, { type: "tick", at: t + 500 }, 10_000);
  }
  const phases = notices.filter((n) => n.phase !== "update").map((n) => [n.phase, n.event.startMs, n.event.endMs]);
  expect(phases).toEqual([
    ["start", 0, null],
    ["end", 0, 60_500],
    ["start", 60_500, null],
  ]);
});

test("stopAll closes what is running", async () => {
  const { tracker, notices } = await setup();
  tracker.signal(cam, { type: "onvif", at: 0, kind: "person", active: true, sync: false }, 10_000);
  tracker.stopAll(5_000);
  expect(notices.at(-1)).toMatchObject({ phase: "end", event: { endMs: 5_000, labels: ["person"], source: "onvif" } });
});

test("filter mode writes nothing until a label is confirmed, then uses that frame as the thumbnail", async () => {
  const { tracker, notices, dataDir } = await setup(undefined, undefined, () => 3_000);
  tracker.signal(cam, px(0, 0.02), 10_000);
  tracker.signal(cam, px(200, 0.02), 10_000);
  expect(tracker.wantsObjects(cam)).toBe(true);
  expect(tracker.activeFor(cam)).toBeNull();
  const hit = { type: "objects", at: 500, hits: [{ label: "person", score: 0.8 }] } as const;
  tracker.signal(cam, hit, 10_000, frame([1], [person]));
  expect(notices).toEqual([]);
  tracker.signal(cam, { ...hit, at: 1000 }, 10_000, frame([2], [person]));
  const event = tracker.activeFor(cam)!;
  expect(event).toMatchObject({ startMs: 0, labels: ["person"] });
  await Bun.sleep(20);
  expect(await Bun.file(thumbPath(dataDir, event.id)).bytes()).toEqual(new Uint8Array([2]));
  // 快照不會蓋掉辨識畫面
  tracker.offerJpeg(cam, new Uint8Array([3]));
  await Bun.sleep(20);
  expect(await Bun.file(thumbPath(dataDir, event.id)).bytes()).toEqual(new Uint8Array([2]));
  expect(notices.map((n) => n.phase)).toEqual(["start", "update"]);
});

test("filter mode drops motion that never shows a watched label", async () => {
  const { tracker, notices, db } = await setup(undefined, undefined, () => 3_000);
  tracker.signal(cam, px(0, 0.02), 10_000);
  tracker.signal(cam, px(200, 0.02), 10_000);
  tracker.signal(cam, { type: "objects", at: 600, hits: [] }, 10_000, frame([1], []));
  tracker.signal(cam, { type: "tick", at: 3_500 }, 10_000);
  expect(tracker.wantsObjects(cam)).toBe(false);
  expect(notices).toEqual([]);
  expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
});

test("a database write that fails is reported and does not throw into the caller", async () => {
  const db = openDb(":memory:");
  const dataDir = await mkdtemp(join(tmpdir(), "cookienvr-tracker-"));
  const errors: unknown[] = [];
  const tracker = createEventTracker({ db, dataDir, now: () => 100_000, onError: (e) => errors.push(e) });
  db.run("DROP TABLE events");
  tracker.signal(cam, px(0, 0.02), 10_000);
  tracker.signal(cam, px(200, 0.03), 10_000);
  expect(errors.length).toBeGreaterThan(0);
});

test("a snapshot thumbnail has no boxes; a recognised frame that becomes the thumbnail keeps its boxes, and every recognised frame of the event is kept", async () => {
  const { tracker, db } = await setup();
  tracker.signal(cam, px(0, 0.02), 10_000);
  tracker.signal(cam, px(200, 0.03), 10_000);
  const id = tracker.activeFor(cam)!.id;
  tracker.offerJpeg(cam, new Uint8Array([0xff]));
  await Bun.sleep(20);
  expect(getEvent(db, id)).toMatchObject({ hasThumb: true, thumbBoxes: null });

  const car: EventBoxDto = { label: "car", score: 0.6, box: [0.5, 0.5, 0.9, 0.9] };
  const hit = (at: number) => ({ type: "objects", at, hits: [{ label: "person", score: 0.8 }] }) as const;
  tracker.signal(cam, hit(400), 10_000, frame([1], [person]));
  tracker.signal(cam, hit(600), 10_000, frame([2], [person, car]));
  tracker.signal(cam, { type: "objects", at: 800, hits: [] }, 10_000, frame([3], []));
  await Bun.sleep(20);
  expect(getEvent(db, id)!.thumbBoxes).toEqual([person, car]);
  expect(eventBoxes(db, id)).toEqual([
    { atMs: 400, boxes: [person] },
    { atMs: 600, boxes: [person, car] },
  ]);
});

test("boxes stored as broken JSON read back as no boxes instead of failing the event", async () => {
  const { db } = await setup();
  const e = insertEvent(db, { cameraId: cam, source: "pixel", startMs: 0, score: 0, labels: [] });
  db.query(`UPDATE events SET thumb_boxes = ? WHERE id = ?`).run(`[{"label":"person","score":0.9,"box":[0,0,1]}, "x"]`, e.id);
  db.query(`INSERT INTO event_boxes (event_id, at_ms, boxes) VALUES (?, 5, '{')`).run(e.id);
  expect(getEvent(db, e.id)!.thumbBoxes).toEqual([]);
  expect(eventBoxes(db, e.id)).toEqual([{ atMs: 5, boxes: [] }]);
});

describe("deleting an event deletes its boxes", () => {
  const seedBoxes = (db: Database, startMs: number, endMs: number) => {
    const e = insertEvent(db, { cameraId: cam, source: "pixel", startMs, score: 0, labels: [] });
    db.query(`UPDATE events SET end_ms = ? WHERE id = ?`).run(endMs, e.id);
    insertEventBoxes(db, e.id, startMs, [person]);
    return e.id;
  };
  const boxRows = (db: Database) => (db.query(`SELECT COUNT(*) AS n FROM event_boxes`).get() as { n: number }).n;

  test("through the tracker", async () => {
    const { tracker, db } = await setup();
    const id = seedBoxes(db, 0, 1_000);
    expect(await tracker.remove(id)).toBe("deleted");
    expect(boxRows(db)).toBe(0);
  });

  test("through retention", async () => {
    const { db, dataDir } = await setup();
    seedBoxes(db, 0, 1_000);
    const now = 10 * 86_400_000;
    const keep = seedBoxes(db, now - 2_000, now - 1_000);
    const settings = () => ({ storagePath: dataDir, retention: { eventDays: 1, continuousDays: 1, minFreeBytes: 0 } }) as never;
    await createRetention({ db, dataDir, settings, freeBytes: async () => 10 ** 12, dev: () => 1 }).runOnce(now);
    expect(eventBoxes(db, keep)).toHaveLength(1);
    expect(boxRows(db)).toBe(1);
  });

  test("through a camera purge", async () => {
    const { db, dataDir } = await setup();
    seedBoxes(db, 0, 1_000);
    await purgeCamera({ db, dataDir, storagePath: () => dataDir }, cam);
    expect(boxRows(db)).toBe(0);
  });
});
