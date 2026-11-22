import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { blobFrame, cam, fakeWorker, harness, jsonFrame } from "./test-helpers.ts";

test("the classifier gets the snapshot once ready and its reading becomes the sensor's last reading", async () => {
  const h = harness();
  const [spec] = h.states.workerSpecs();
  expect(spec?.cmd).toContain(h.socketPath);
  const w = await fakeWorker(h.socketPath);
  await h.settle();
  h.states.offerJpeg(cam, new Uint8Array([1]), Date.now());
  await h.settle();
  expect(w.received).toEqual([]);
  expect(h.sensor().problem?.code).toBe("worker");

  w.ready();
  await h.settle();
  expect(h.states.diagnostics().worker).toMatchObject({ phase: "ready", backbone: "DINOv2-small (int8)", loadMs: 12 });
  h.states.offerJpeg(cam, new Uint8Array([2, 3]), Date.now());
  await h.settle();
  expect(w.received).toHaveLength(1);
  const req = w.received[0]!;
  expect(req).toMatchObject({ kind: 3, json: { type: "classify", sensor: h.sensorId, crop: [0, 0, 1, 1], mode: "force" } });
  expect([...req.blob!]).toEqual([2, 3]);

  w.send(blobFrame({ type: "reading", id: req.json.id, label: "開", score: 0.97, ms: 20 }, new Uint8Array([0xff, 0xd8])));
  await h.settle();
  expect(h.sensor().lastReading).toMatchObject({ label: "開", score: 0.97 });
  expect(h.sensor().candidate).toEqual({ label: "開", count: 1 });
  expect(h.published.some((m) => m.type === "state-sensor")).toBe(true);

  w.end();
  await h.states.stop();
});

test("a new connection replaces the old one and fails the job that was sent on it", async () => {
  const h = harness();
  h.states.workerSpecs();
  const first = await fakeWorker(h.socketPath);
  first.ready();
  await h.settle();
  expect((await h.call("POST", "/api/states/:id/collect")).status).toBe(202);
  await h.settle();
  expect(first.received.map((r) => r.json.type)).toEqual(["collect"]);
  expect(h.sensor().job?.state).toBe("queued");

  const second = await fakeWorker(h.socketPath);
  await h.settle();
  expect(first.closed()).toBe(true);
  expect(h.states.diagnostics().worker.phase).toBe("starting");
  expect(h.sensor().job).toMatchObject({ state: "failed", errorMsg: { code: "states.workerRestarted" } });

  second.ready();
  await h.settle();
  h.states.offerJpeg(cam, new Uint8Array([9]), Date.now());
  await h.settle();
  expect(second.received.map((r) => r.json.type)).toEqual(["classify"]);
  expect(first.received).toHaveLength(1);

  second.end();
  await h.settle();
  expect(h.states.diagnostics().worker.phase).toBe("starting");
  await h.states.stop();
});

test("a collect job finishes with the frames it found, or fails when it found none", async () => {
  const h = harness();
  h.states.workerSpecs();
  const w = await fakeWorker(h.socketPath);
  w.ready();
  await h.settle();

  await h.call("POST", "/api/states/:id/collect");
  await h.settle();
  w.send(jsonFrame({ type: "job-result", job: w.received[0]!.json.job, ok: true, result: { images: [] } }));
  await h.settle();
  expect(h.sensor().job).toMatchObject({ kind: "collect", state: "failed", errorMsg: { code: "states.collectNoFrames" } });

  await h.call("POST", "/api/states/:id/collect");
  await h.settle();
  w.send(jsonFrame({ type: "job-result", job: w.received[1]!.json.job, ok: true, result: { images: [{ file: "a1.jpg", at: 5 }, { file: "a2.jpg", at: 6 }] } }));
  await h.settle();
  expect(h.sensor().job).toMatchObject({ kind: "collect", state: "done", msg: { code: "states.collectDone", params: { count: 2 } } });
  expect(h.sensor().images.pending).toBe(2);

  w.end();
  await h.states.stop();
});

test("the uploaded zip is deleted once its import job finishes", async () => {
  const h = harness();
  h.states.workerSpecs();
  const w = await fakeWorker(h.socketPath);
  w.ready();
  await h.settle();
  const zip = new Uint8Array(64);
  zip.set([0x50, 0x4b, 3, 4]);
  const res = await h.call("POST", "/api/states/:id/import", { body: zip, headers: { "content-type": "application/zip" } });
  expect(res.status).toBe(202);
  await h.settle();
  const cmd = w.received[0]!.json;
  expect(cmd.type).toBe("import");
  expect(existsSync(cmd.zip as string)).toBe(true);

  w.send(jsonFrame({ type: "job-result", job: cmd.job, ok: true, result: { labeled: [], pending: [], skipped: 0 } }));
  await h.settle();
  expect(h.sensor().job).toMatchObject({ kind: "import", state: "failed", errorMsg: { code: "states.importNoImages" } });
  expect(readdirSync(h.dir).filter((f) => f.endsWith(".zip"))).toEqual([]);

  w.end();
  await h.states.stop();
});
