import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StateChangeDto, StateImageDto, StateSensorDto } from "../api-types.ts";
import { stateRoutes } from "./routes.ts";
import { cam, harness } from "./test-helpers.ts";
import * as store from "./store.ts";

const sensorConfig = { name: "大門", classes: ["關", "開"], crop: [0, 0, 0.5, 0.5] };
const body = async (res: Response) => (await res.json()) as Record<string, unknown>;

function addImages(h: ReturnType<typeof harness>, specs: { id: string; label: string | null }[]) {
  const dir = join(h.dir, "images");
  mkdirSync(dir, { recursive: true });
  for (const s of specs) writeFileSync(join(dir, `${s.id}.jpg`), "jpeg");
  store.insertImages(
    h.db,
    specs.map((s, i) => ({ id: s.id, sensorId: h.sensorId as store.SensorId, file: `${s.id}.jpg`, label: s.label, source: "live", createdAt: 100 + i, guess: null })),
  );
}

test("every route keeps its method, path and access", () => {
  const h = harness();
  expect(stateRoutes(h.states).map((r) => [r.method, r.path, r.access])).toEqual([
    ["GET", "/api/states", "user"],
    ["POST", "/api/states", "admin"],
    ["POST", "/api/states/frigate-config", "admin"],
    ["GET", "/api/states/:id", "user"],
    ["PUT", "/api/states/:id", "admin"],
    ["DELETE", "/api/states/:id", "admin"],
    ["POST", "/api/states/:id/classes/rename", "admin"],
    ["POST", "/api/states/:id/collect", "admin"],
    ["POST", "/api/states/:id/train", "admin"],
    ["POST", "/api/states/:id/import", "admin"],
    ["GET", "/api/states/:id/images", "user"],
    ["GET", "/api/states/:id/images/:imageId", "user"],
    ["POST", "/api/states/:id/images/label", "admin"],
    ["POST", "/api/states/:id/images/delete", "admin"],
    ["GET", "/api/state-changes", "user"],
    ["GET", "/api/state-changes/:id/thumb.jpg", "user"],
  ]);
  expect(stateRoutes(h.states).find((r) => r.path === "/api/states/:id/import")?.accepts).toEqual(["application/zip", "application/x-zip-compressed", "application/octet-stream"]);
});

test("GET /api/states lists sensors, filtered by camera", async () => {
  const h = harness();
  const all = await h.call("GET", "/api/states");
  expect(all.status).toBe(200);
  expect(((await all.json()) as StateSensorDto[]).map((s) => s.id)).toEqual([h.sensorId]);
  expect(await (await h.call("GET", "/api/states", { query: "cameraId=cam1" })).json()).toHaveLength(1);
  expect(await (await h.call("GET", "/api/states", { query: "cameraId=other" })).json()).toEqual([]);
});

test("POST /api/states creates a sensor, collecting from recordings unless told not to", async () => {
  const h = harness();
  const missing = await h.call("POST", "/api/states", { json: { cameraId: "nope", config: sensorConfig } });
  expect(missing.status).toBe(400);
  expect(await body(missing)).toMatchObject({ code: "states.cameraNotFound" });
  expect(await body(await h.call("POST", "/api/states", { json: [] }))).toMatchObject({ code: "http.bodyNotObject" });
  expect(await body(await h.call("POST", "/api/states", { json: { cameraId: "cam1", config: { ...sensorConfig, classes: ["a"] } } }))).toMatchObject({
    code: "states.classCount",
  });

  const quiet = await h.call("POST", "/api/states", { json: { cameraId: "cam1", config: sensorConfig, collect: false } });
  expect(quiet.status).toBe(201);
  const created = (await quiet.json()) as StateSensorDto;
  expect(created).toMatchObject({ cameraId: "cam1", config: { name: "大門", classes: ["關", "開"], threshold: 0.8, intervalSec: 10 }, job: null, model: null });
  expect(h.published.some((m) => m.type === "state-sensor" && m.data.id === created.id)).toBe(true);

  const collecting = (await (await h.call("POST", "/api/states", { json: { cameraId: "cam1", config: sensorConfig } })).json()) as StateSensorDto;
  expect(collecting.job).toMatchObject({ kind: "collect", state: "queued" });
  expect(h.states.list()).toHaveLength(3);
});

test("POST /api/states/frigate-config reads a Frigate snippet", async () => {
  const h = harness();
  const yaml = "garage:\n  threshold: 0.9\n  state_config:\n    motion: true\n    cameras:\n      front:\n        crop: [0.1, 0.1, 0.4, 0.4]\n";
  const ok = await h.call("POST", "/api/states/frigate-config", { json: { yaml } });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ sensors: [{ name: "garage", camera: "front", crop: [0.1, 0.1, 0.4, 0.4], threshold: 0.9, intervalSec: 0, onMotion: true }] });
  const bad = await h.call("POST", "/api/states/frigate-config", { json: { yaml: 5 } });
  expect(bad.status).toBe(400);
  expect(await body(bad)).toMatchObject({ code: "states.yamlNotString" });
  expect(await body(await h.call("POST", "/api/states/frigate-config", { json: { yaml: "x: 1" } }))).toMatchObject({ code: "states.frigateConfigNotFound" });
});

test("GET /api/states/:id returns the sensor or 404", async () => {
  const h = harness();
  const ok = await h.call("GET", "/api/states/:id");
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ id: h.sensorId, config: { name: "鐵捲門" }, model: { classes: ["關", "開"] } });
  const missing = await h.call("GET", "/api/states/:id", { params: { id: "nope" } });
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "找不到這個狀態感應器", code: "states.sensorNotFound" });
});

test("PUT /api/states/:id replaces the config, keeping omitted optional fields", async () => {
  const h = harness();
  const ok = await h.call("PUT", "/api/states/:id", { json: { config: { name: "車庫門", classes: ["關", "開"], crop: [0, 0, 1, 1] } } });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ config: { name: "車庫門", intervalSec: 10, onMotion: true } });
  expect(h.published.at(-1)).toMatchObject({ type: "state-sensor", data: { config: { name: "車庫門" } } });
  const bad = await h.call("PUT", "/api/states/:id", { json: { config: { ...sensorConfig, threshold: 2 } } });
  expect(bad.status).toBe(400);
  expect(await body(bad)).toMatchObject({ code: "states.thresholdRange", params: { min: 0.5, max: 0.99 } });
  expect((await h.call("PUT", "/api/states/:id", { params: { id: "nope" }, json: {} })).status).toBe(404);
});

test("DELETE /api/states/:id removes the sensor and its files", async () => {
  const h = harness();
  const res = await h.call("DELETE", "/api/states/:id");
  expect(res.status).toBe(204);
  expect(await res.text()).toBe("");
  expect(existsSync(h.dir)).toBe(false);
  expect(h.states.list()).toEqual([]);
  expect(h.published.at(-1)).toEqual({ type: "state-sensor-removed", data: { id: h.sensorId } });
  expect((await h.call("DELETE", "/api/states/:id")).status).toBe(404);
});

test("POST /api/states/:id/classes/rename renames in the config and the model", async () => {
  const h = harness();
  const ok = await h.call("POST", "/api/states/:id/classes/rename", { json: { from: "開", to: "打開" } });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ config: { classes: ["關", "打開"] }, model: { classes: ["關", "打開"] } });
  expect(JSON.parse(readFileSync(join(h.dir, "model.json"), "utf8")).classes).toEqual(["關", "打開"]);

  const missing = await h.call("POST", "/api/states/:id/classes/rename", { json: { from: "開", to: "x" } });
  expect(missing.status).toBe(400);
  expect(await body(missing)).toMatchObject({ code: "states.classNotFound", params: { name: "開" } });
  expect(await body(await h.call("POST", "/api/states/:id/classes/rename", { json: { from: "關", to: "打開" } }))).toMatchObject({
    code: "states.classExists",
    params: { name: "打開" },
  });
  expect(await body(await h.call("POST", "/api/states/:id/classes/rename", { json: { from: "關", to: ".x" } }))).toMatchObject({
    code: "states.classNameChars",
    params: { renamed: true },
  });
});

test("POST /api/states/:id/collect queues a collect job and refuses a second", async () => {
  const h = harness();
  const ok = await h.call("POST", "/api/states/:id/collect");
  expect(ok.status).toBe(202);
  expect(await ok.json()).toMatchObject({ job: { kind: "collect", state: "queued" } });
  const busy = await h.call("POST", "/api/states/:id/collect");
  expect(busy.status).toBe(409);
  expect(await busy.json()).toEqual({ error: "這個感應器正在進行其他工作，請等它完成", code: "states.jobBusy" });
});

test("POST /api/states/:id/collect without recordings fails the job at once", async () => {
  const h = harness({ segments: [] });
  const res = await h.call("POST", "/api/states/:id/collect");
  expect(res.status).toBe(202);
  expect(await res.json()).toMatchObject({ job: { kind: "collect", state: "failed", errorMsg: { code: "states.collectNoRecordings" } } });
});

test("POST /api/states/:id/train needs enough labeled images and refuses while a job runs", async () => {
  const h = harness();
  const short = await h.call("POST", "/api/states/:id/train");
  expect(short.status).toBe(400);
  expect(await short.json()).toEqual({ error: "每一類至少要有 2 張已標記的圖片才能訓練", code: "states.notTrainable", params: { min: 2 } });

  addImages(h, [
    { id: "a1", label: "關" },
    { id: "a2", label: "關" },
    { id: "b1", label: "開" },
    { id: "b2", label: "開" },
  ]);
  const ok = await h.call("POST", "/api/states/:id/train");
  expect(ok.status).toBe(202);
  expect(await ok.json()).toMatchObject({ trainable: true, job: { kind: "train", state: "queued" } });
  const busy = await h.call("POST", "/api/states/:id/train");
  expect(busy.status).toBe(409);
  expect(await busy.json()).toEqual({ error: "這個感應器正在進行其他工作，請等它完成", code: "states.jobBusy" });
  const importBusy = await h.call("POST", "/api/states/:id/import", { body: new Uint8Array(64), headers: { "content-type": "application/zip" } });
  expect(importBusy.status).toBe(409);
  expect(await body(importBusy)).toMatchObject({ code: "states.jobBusy" });
});

test("POST /api/states/:id/import rejects what is not a zip, or too large, and keeps no upload", async () => {
  const h = harness();
  const notZip = await h.call("POST", "/api/states/:id/import", { body: new Uint8Array(64), headers: { "content-type": "application/zip" } });
  expect(notZip.status).toBe(400);
  expect(await notZip.json()).toEqual({ error: "這不是 zip 檔", code: "states.notZip" });
  const large = await h.call("POST", "/api/states/:id/import", { body: new Uint8Array(4), headers: { "content-type": "application/zip", "content-length": String(200 * 1024 * 1024) } });
  expect(large.status).toBe(413);
  expect(await body(large)).toMatchObject({ code: "states.fileTooLarge" });
  expect(readdirSync(h.dir).filter((f) => f.endsWith(".zip"))).toEqual([]);
  expect(h.sensor().job).toBeNull();
});

test("GET /api/states/:id/images filters by label", async () => {
  const h = harness();
  addImages(h, [
    { id: "a1", label: "關" },
    { id: "b1", label: "開" },
    { id: "c1", label: null },
  ]);
  const ids = async (query?: string) => ((await (await h.call("GET", "/api/states/:id/images", { query })).json()) as { images: StateImageDto[] }).images.map((i) => i.id).sort();
  expect(await ids()).toEqual(["a1", "b1", "c1"]);
  expect(await ids("label=pending")).toEqual(["c1"]);
  expect(await ids("label=開")).toEqual(["b1"]);
  const [first] = ((await (await h.call("GET", "/api/states/:id/images", { query: "label=關" })).json()) as { images: StateImageDto[] }).images;
  expect(first).toEqual({ id: "a1", label: "關", source: "live", createdAt: 100, guess: null, url: `/api/states/${h.sensorId}/images/a1` });
});

test("GET /api/states/:id/images/:imageId serves the file or 404", async () => {
  const h = harness();
  addImages(h, [{ id: "a1", label: null }]);
  const ok = await h.call("GET", "/api/states/:id/images/:imageId", { params: { imageId: "a1" } });
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toBe("image/jpeg");
  expect(ok.headers.get("cache-control")).toBe("private, max-age=86400, immutable");
  expect(await ok.text()).toBe("jpeg");
  const missing = await h.call("GET", "/api/states/:id/images/:imageId", { params: { imageId: "zz" } });
  expect(missing.status).toBe(404);
  expect(await body(missing)).toMatchObject({ code: "states.imageNotFound" });
});

test("POST /api/states/:id/images/label labels or clears images", async () => {
  const h = harness();
  addImages(h, [
    { id: "a1", label: null },
    { id: "a2", label: null },
  ]);
  const ok = await h.call("POST", "/api/states/:id/images/label", { json: { ids: ["a1", "a2"], label: "開" } });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ images: { pending: 0, labeled: [{ label: "關", count: 0 }, { label: "開", count: 2 }] } });
  expect(await (await h.call("POST", "/api/states/:id/images/label", { json: { ids: ["a1"], label: null } })).json()).toMatchObject({ images: { pending: 1 } });

  const badIds = await h.call("POST", "/api/states/:id/images/label", { json: { ids: ["A!"], label: null } });
  expect(badIds.status).toBe(400);
  expect(await body(badIds)).toMatchObject({ code: "states.idsInvalid" });
  expect(await body(await h.call("POST", "/api/states/:id/images/label", { json: { ids: ["a1"], label: "半開" } }))).toMatchObject({
    code: "states.classNotFound",
    params: { name: "半開" },
  });
});

test("POST /api/states/:id/images/delete removes the rows and the files", async () => {
  const h = harness();
  addImages(h, [
    { id: "a1", label: null },
    { id: "a2", label: "關" },
  ]);
  const ok = await h.call("POST", "/api/states/:id/images/delete", { json: { ids: ["a1"] } });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ images: { pending: 0, labeled: [{ label: "關", count: 1 }, { label: "開", count: 0 }] } });
  await Bun.sleep(30);
  expect(readdirSync(join(h.dir, "images"))).toEqual(["a2.jpg"]);
  expect(await body(await h.call("POST", "/api/states/:id/images/delete", { json: { ids: [] } }))).toMatchObject({ code: "states.idsInvalid" });
});

test("GET /api/state-changes pages newest first and ignores a non-numeric before", async () => {
  const h = harness();
  const sensorId = h.sensorId as store.SensorId;
  for (const at of [1000, 2000, 3000]) store.insertChange(h.db, { sensorId, cameraId: cam, at, from: "關", to: "開", score: 0.9, hasThumb: false });
  const list = async (query: string) => (await (await h.call("GET", "/api/state-changes", { query })).json()) as StateChangeDto[];
  expect((await list("")).map((c) => c.at)).toEqual([3000, 2000, 1000]);
  expect((await list("before=3000&limit=1")).map((c) => c.at)).toEqual([2000]);
  expect((await list("before=abc")).map((c) => c.at)).toEqual([3000, 2000, 1000]);
  expect((await list("limit=0")).map((c) => c.at)).toEqual([3000, 2000, 1000]);
  expect(await list("sensorId=other")).toEqual([]);
  expect((await list("limit=1"))[0] as unknown).toEqual({ id: 3, sensorId, cameraId: "cam1", at: 3000, from: "關", to: "開", score: 0.9, thumbUrl: null });
});

test("GET /api/state-changes/:id/thumb.jpg serves a saved thumbnail or 404", async () => {
  const h = harness();
  const sensorId = h.sensorId as store.SensorId;
  const change = store.insertChange(h.db, { sensorId, cameraId: cam, at: 1000, from: null, to: "開", score: 0.9, hasThumb: false });
  const thumb = { params: { id: String(change.id) } };
  expect((await h.call("GET", "/api/state-changes/:id/thumb.jpg", thumb)).status).toBe(404);
  store.setChangeThumb(h.db, change.id);
  mkdirSync(join(h.dir, "changes"), { recursive: true });
  writeFileSync(join(h.dir, "changes", `${change.id}.jpg`), "thumb");
  const ok = await h.call("GET", "/api/state-changes/:id/thumb.jpg", thumb);
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toBe("image/jpeg");
  expect(await ok.text()).toBe("thumb");
  const bad = await h.call("GET", "/api/state-changes/:id/thumb.jpg", { params: { id: "1x" } });
  expect(bad.status).toBe(404);
  expect(await bad.json()).toEqual({ error: "沒有縮圖", code: "states.noThumb" });
});
