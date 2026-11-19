import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EventDto } from "../api-types.ts";
import { openDb } from "../db.ts";
import type { Route } from "../types.ts";
import { eventRoutes, thumbPath } from "./routes.ts";
import { createEventTracker } from "./tracker.ts";

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "cookienvr-events-"));
  const db = openDb(":memory:");
  const routes = eventRoutes({ db, dataDir, events: createEventTracker({ db, dataDir }) });
  const call = (path: string, routePath: string, params: Record<string, string> = {}, method = "GET") => {
    const route = routes.find((r) => r.path === routePath && r.method === method) as Route;
    const url = new URL(`http://nvr${path}`);
    return route.handler({ req: new Request(url, { method }), url, params, principal: null, ip: "127.0.0.1" });
  };
  const insert = (camera: string, start: number, end: number | null, labels: string[] = [], hasThumb = false) =>
    db
      .query(`INSERT INTO events (camera_id, source, start_ms, end_ms, score, labels, has_thumb) VALUES (?, 'pixel', ?, ?, 0.4, ?, ?) RETURNING id`)
      .get(camera, start, end, JSON.stringify(labels), hasThumb ? 1 : 0) as { id: number };
  const list = async (qs: string) => {
    const res = await call(`/api/events?${qs}`, "/api/events");
    return { status: res.status, body: (await res.json()) as EventDto[] };
  };
  return { dataDir, call, insert, list, routes };
}

test("reading needs a signed-in user, deleting an admin", async () => {
  const { routes } = await setup();
  expect(routes.map((r) => [r.method, r.path, r.access])).toEqual([
    ["GET", "/api/events", "user"],
    ["GET", "/api/events/:id", "user"],
    ["DELETE", "/api/events/:id", "admin"],
    ["GET", "/api/events/:id/thumb.jpg", "user"],
  ]);
});

test("before pages newest first across cameras", async () => {
  const { insert, list } = await setup();
  for (let i = 1; i <= 5; i++) insert(i % 2 ? "cam1" : "cam2", i * 1000, i * 1000 + 500);
  expect((await list("before=99999&limit=2")).body.map((e) => e.startMs)).toEqual([5000, 4000]);
  expect((await list("before=4000&limit=2")).body.map((e) => e.startMs)).toEqual([3000, 2000]);
  expect((await list("before=99999&camera=cam2")).body.map((e) => e.startMs)).toEqual([4000, 2000]);
  expect((await list("before=x")).status).toBe(400);
});

test("deleting removes the event and its thumbnail, but not while it is in progress", async () => {
  const { dataDir, call, insert } = await setup();
  const done = insert("cam1", 1_000, 2_000, [], true).id;
  const running = insert("cam1", 3_000, null).id;
  const path = thumbPath(dataDir, done);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "jpeg");
  const del = (id: number) => call(`/api/events/${id}`, "/api/events/:id", { id: String(id) }, "DELETE");
  expect((await del(running)).status).toBe(409);
  expect((await del(done)).status).toBe(204);
  expect(await Bun.file(path).exists()).toBe(false);
  expect((await call(`/api/events/${done}`, "/api/events/:id", { id: String(done) })).status).toBe(404);
  expect((await del(done)).status).toBe(404);
});

test("an empty events table lists nothing", async () => {
  const { list } = await setup();
  expect(await list("camera=cam1&start=0&end=100")).toEqual({ status: 200, body: [] });
});

test("events overlapping the range come back sorted by start, in-progress included", async () => {
  const { insert, list } = await setup();
  insert("cam1", 5_000, 6_000, ["person"]);
  insert("cam1", 1_000, 2_000);
  insert("cam1", 9_000, null, ["cat", "person"], true);
  insert("cam1", 20_000, 21_000);
  insert("cam2", 1_500, 1_600);

  const { status, body } = await list("camera=cam1&start=1500&end=10000");
  expect(status).toBe(200);
  expect(body.map((e) => [e.startMs, e.endMs])).toEqual([
    [1_000, 2_000],
    [5_000, 6_000],
    [9_000, null],
  ]);
  expect(body[2]).toMatchObject({ cameraId: "cam1", source: "pixel", labels: ["cat", "person"], hasThumb: true, score: 0.4 });

  expect((await list("start=0&end=100000")).body).toHaveLength(5);
  expect((await list("camera=cam1&start=0&end=100000&limit=2")).body.map((e) => e.startMs)).toEqual([1_000, 5_000]);
});

test("bad query parameters are rejected", async () => {
  const { list } = await setup();
  expect((await list("start=abc&end=1")).status).toBe(400);
  expect((await list("start=10&end=1")).status).toBe(400);
  expect((await list("limit=0")).status).toBe(400);
});

test("thumbnails are served from the data directory and 404 when missing", async () => {
  const { dataDir, call, insert } = await setup();
  const withThumb = insert("cam1", 1_000, 2_000, [], true).id;
  const without = insert("cam1", 3_000, null).id;
  const path = thumbPath(dataDir, withThumb);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "jpeg-bytes");

  const thumb = (id: number | string) => call(`/api/events/${id}/thumb.jpg`, "/api/events/:id/thumb.jpg", { id: String(id) });
  const ok = await thumb(withThumb);
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toBe("image/jpeg");
  expect(await ok.text()).toBe("jpeg-bytes");
  expect((await thumb(without)).status).toBe(404);
  expect((await thumb(999)).status).toBe(404);
  expect((await thumb("x")).status).toBe(404);
});
