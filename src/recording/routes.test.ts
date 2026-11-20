import { expect, test } from "bun:test";
import { appendFile, chmod, rm } from "node:fs/promises";
import { openDb } from "../db.ts";
import type { SegmentDto } from "../api-types.ts";
import type { Route } from "../types.ts";
import { createIndexer } from "./indexer.ts";
import { recordingRoutes } from "./routes.ts";
import { tempSettings, writeSegment } from "./test-helpers.ts";

async function setup() {
  const settings = await tempSettings();
  const db = openDb(":memory:");
  const routes = recordingRoutes({ db, purgeOrphans: async () => ({ segments: 0, events: 0, bytes: 0 }) });
  const call = (path: string, routePath: string, params: Record<string, string>, headers: HeadersInit = {}) => {
    const route = routes.find((r) => r.path === routePath) as Route;
    const url = new URL(`http://nvr${path}`);
    return route.handler({ req: new Request(url, { headers }), url, params, principal: null, ip: "127.0.0.1" });
  };
  return { settings, db, call, indexer: createIndexer({ db, settings: () => settings }) };
}

test("route access levels", () => {
  const routes = recordingRoutes({ db: openDb(":memory:"), purgeOrphans: async () => ({ segments: 0, events: 0, bytes: 0 }) });
  expect(routes.map((r) => [r.method, r.path, r.access])).toEqual([
    ["DELETE", "/api/recordings/orphaned", "admin"],
    ["GET", "/api/cameras/:id/days", "user"],
    ["GET", "/api/cameras/:id/recordings", "user"],
    ["GET", "/api/segments/:id", "user"],
  ]);
});

test("days are reported in the requested time zone", async () => {
  const { settings, call, indexer } = await setup();
  const t = Date.UTC(2026, 10, 18, 23, 30);
  await writeSegment(settings, "cam1", t, 1, t + 60_000);
  await writeSegment(settings, "cam1", t + 3600_000, 1, t + 3660_000);
  await indexer.reconcile(t + 4000_000);

  const days = async (tz: string) => (await call(`/api/cameras/cam1/days?tz=${tz}`, "/api/cameras/:id/days", { id: "cam1" })).json();
  expect(await days("UTC")).toEqual(["2026-11-18", "2026-11-19"]);
  expect(await days("Asia/Taipei")).toEqual(["2026-11-19"]);
  expect(await days("America/Los_Angeles")).toEqual(["2026-11-18"]);
  expect(await days("Asia/Kolkata")).toEqual(["2026-11-19"]);
  expect((await call("/api/cameras/cam1/days?tz=Nope/Zone", "/api/cameras/:id/days", { id: "cam1" })).status).toBe(400);
});

test("recordings in a range include the segment still being written", async () => {
  const { settings, call, indexer } = await setup();
  const t = Date.UTC(2026, 10, 18, 12, 0);
  await writeSegment(settings, "cam1", t - 60_000, 5, t - 1);
  await writeSegment(settings, "cam1", t, 7, t + 10_000);
  await writeSegment(settings, "other", t, 7, t + 10_000);
  await indexer.scanOnce(t + 11_000);

  const res = await call(`/api/cameras/cam1/recordings?start=${t - 30_000}&end=${t + 60_000}`, "/api/cameras/:id/recordings", { id: "cam1" });
  const list = (await res.json()) as SegmentDto[];
  expect(list.map(({ id: _, ...s }) => s)).toEqual([
    { cameraId: "cam1" as never, startMs: t - 60_000, endMs: t - 1, size: 5 },
    { cameraId: "cam1" as never, startMs: t, endMs: null, size: 7 },
  ]);

  const later = await call(`/api/cameras/cam1/recordings?start=${t + 1}&end=${t + 2}`, "/api/cameras/:id/recordings", { id: "cam1" });
  expect(((await later.json()) as SegmentDto[]).map((s) => s.startMs)).toEqual([t]);
  expect((await call("/api/cameras/cam1/recordings?start=abc&end=1", "/api/cameras/:id/recordings", { id: "cam1" })).status).toBe(400);
});

test("segment download honours Range against the file's current size", async () => {
  const { settings, call, indexer, db } = await setup();
  const t = Date.UTC(2026, 10, 18, 12, 0);
  const path = await writeSegment(settings, "cam1", t, 0, t);
  await Bun.write(path, "0123456789");
  await indexer.scanOnce(t + 1_000);
  const { id } = db.query("SELECT id FROM segments").get() as { id: number };
  const get = (range?: string) => call(`/api/segments/${id}`, "/api/segments/:id", { id: String(id) }, range ? { range } : {});

  const full = await get();
  expect(full.status).toBe(200);
  expect(full.headers.get("content-type")).toBe("video/mp4");
  expect(await full.text()).toBe("0123456789");

  const part = await get("bytes=2-4");
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe("bytes 2-4/10");
  expect(await part.text()).toBe("234");

  await appendFile(path, "abcdef");
  const tail = await get("bytes=8-");
  expect(tail.headers.get("content-range")).toBe("bytes 8-15/16");
  expect(await tail.text()).toBe("89abcdef");

  const suffix = await get("bytes=-3");
  expect(await suffix.text()).toBe("def");

  const past = await get("bytes=16-");
  expect(past.status).toBe(416);
  expect(past.headers.get("content-range")).toBe("bytes */16");

  expect((await call("/api/segments/999", "/api/segments/:id", { id: "999" })).status).toBe(404);
});

test("an indexed segment the server cannot read is refused up front, so the player skips it", async () => {
  const { settings, call, indexer, db } = await setup();
  const t = Date.UTC(2026, 10, 18, 12, 0);
  const path = await writeSegment(settings, "cam1", t, 0, t);
  await Bun.write(path, "0123456789");
  await indexer.scanOnce(t + 1_000);
  const { id } = db.query("SELECT id FROM segments").get() as { id: number };
  const get = () => call(`/api/segments/${id}`, "/api/segments/:id", { id: String(id) });
  // root reads everything, so the check only means something for an unprivileged test run
  if (process.getuid?.() !== 0) {
    await chmod(path, 0o000);
    expect((await get()).status).toBe(403);
    await chmod(path, 0o644);
  }
  await rm(path);
  expect((await get()).status).toBe(404);
});

test("DELETE /api/recordings/orphaned reports what the purge freed", async () => {
  const db = openDb(":memory:");
  const route = recordingRoutes({ db, purgeOrphans: async () => ({ segments: 2, events: 1, bytes: 30 }) })[0] as Route;
  const url = new URL("http://nvr/api/recordings/orphaned");
  const res = await route.handler({ req: new Request(url, { method: "DELETE" }), url, params: {}, principal: null, ip: "127.0.0.1" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ segments: 2, events: 1, bytes: 30 });
});
