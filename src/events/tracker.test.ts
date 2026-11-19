import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.ts";
import type { CameraId } from "../types.ts";
import { MAX_EVENT_MS } from "./lifecycle.ts";
import { thumbPath } from "./paths.ts";
import { getEvent, insertEvent } from "./store.ts";
import { createEventTracker, type EventNotice } from "./tracker.ts";

const cam = "cam1" as CameraId;
const px = (at: number, score: number) => ({ type: "pixel", at, score, motion: true }) as const;

async function setup(db = openDb(":memory:"), now = () => 100_000) {
  const dataDir = await mkdtemp(join(tmpdir(), "cookienvr-tracker-"));
  const tracker = createEventTracker({ db, dataDir, now });
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

test("stopAll closes what is running", async () => {
  const { tracker, notices } = await setup();
  tracker.signal(cam, { type: "onvif", at: 0, kind: "person", active: true, sync: false }, 10_000);
  tracker.stopAll(5_000);
  expect(notices.at(-1)).toMatchObject({ phase: "end", event: { endMs: 5_000, labels: ["person"], source: "onvif" } });
});
