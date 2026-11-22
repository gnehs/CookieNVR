import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import backboneModel from "../../detector/backbone-model.json";
import type { StreamMessage } from "../api-types.ts";
import { openDb } from "../db.ts";
import { DEFAULT_DETECT } from "../detect/config.ts";
import type { Camera, CameraId } from "../types.ts";
import { createStateClassification } from "./service.ts";
import * as store from "./store.ts";

const cam = "cam1" as CameraId;
const camera: Camera = {
  id: cam,
  position: 0,
  groupId: null,
  createdAt: 0,
  updatedAt: 0,
  config: {
    name: "車庫",
    enabled: true,
    connection: { type: "rtsp", mainUrl: "rtsp://x/y", transport: "tcp" },
    record: { enabled: false, audio: false, direct: false },
    detect: DEFAULT_DETECT,
  },
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function frame(kind: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + body.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, body.length);
  out.set(body, 5);
  return out;
}

const jsonFrame = (v: object) => frame(1, enc.encode(JSON.stringify(v)));

function blobFrame(v: object, blob: Uint8Array): Uint8Array {
  const head = enc.encode(JSON.stringify(v));
  const body = new Uint8Array(4 + head.length + blob.length);
  new DataView(body.buffer).setUint32(0, head.length);
  body.set(head, 4);
  body.set(blob, 4 + head.length);
  return frame(3, body);
}

type Received = { kind: number; json: Record<string, unknown>; blob: Uint8Array | null };

/** 用 Bun 假裝成 classify.py：連上 socket、照協定收發 */
async function fakeWorker(socketPath: string) {
  const received: Received[] = [];
  let buf = new Uint8Array(0);
  let closed = false;
  const client: Socket<undefined> = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, chunk) {
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf);
        merged.set(chunk, buf.length);
        let p = 0;
        while (merged.length - p >= 5) {
          const len = new DataView(merged.buffer, p + 1, 4).getUint32(0);
          if (merged.length - p - 5 < len) break;
          const kind = merged[p]!;
          const payload = merged.slice(p + 5, p + 5 + len);
          if (kind === 3) {
            const n = new DataView(payload.buffer).getUint32(0);
            received.push({ kind, json: JSON.parse(dec.decode(payload.subarray(4, 4 + n))), blob: payload.slice(4 + n) });
          } else received.push({ kind, json: JSON.parse(dec.decode(payload)), blob: null });
          p += 5 + len;
        }
        buf = merged.slice(p);
      },
      close() {
        closed = true;
      },
    },
  });
  return {
    received,
    closed: () => closed,
    send: (bytes: Uint8Array) => client.write(bytes),
    ready: () => client.write(jsonFrame({ type: "status", state: "ready", backbone: "DINOv2-small (int8)", loadMs: 12 })),
    end: () => client.end(),
  };
}

function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), "cnvr-states-"));
  const db = openDb(":memory:");
  const sensorId = store.newSensorId();
  store.insertSensor(db, {
    id: sensorId,
    cameraId: cam,
    config: { name: "鐵捲門", classes: ["關", "開"], crop: [0, 0, 1, 1], threshold: 0.8, intervalSec: 10, onMotion: true, enabled: true },
    createdAt: 1,
  });
  const dir = join(dataDir, "states", sensorId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "model.json"),
    JSON.stringify({ trainedAt: 1, classes: ["關", "開"], counts: { 關: 10, 開: 10 }, validation: null, trainMs: 5, backbone: { id: backboneModel.id, name: backboneModel.name } }),
  );
  const published: StreamMessage[] = [];
  const socketPath = join(mkdtempSync("/tmp/cnvr-"), "c.sock");
  const states = createStateClassification({
    db,
    env: { detectorPython: "python3", dataDir, ffmpegBin: "ffmpeg" },
    cameras: () => [camera],
    blocked: () => false,
    segments: () => [{ path: "a.mp4", startMs: 0, endMs: 60_000 }],
    publish: (m) => published.push(m),
    onWorkersChanged: () => {},
    socketPath,
  });
  const call = async (method: string, path: string, init?: { body?: BodyInit; headers?: Record<string, string> }) => {
    const route = states.routes().find((r) => r.method === method && r.path === path)!;
    const url = path.replace(":id", sensorId);
    const req = new Request(`http://x${url}`, { method, ...init });
    return (await route.handler({ req, url: new URL(req.url), params: { id: sensorId }, principal: null, ip: "127.0.0.1" })) as Response;
  };
  const sensor = () => states.list()[0]!;
  return { states, socketPath, sensorId, dir, published, call, sensor, settle: () => Bun.sleep(30) };
}

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
