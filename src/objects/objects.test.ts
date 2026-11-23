import { expect, test } from "bun:test";
import { msg } from "../messages/index.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DETECT } from "../detect/config.ts";
import { MsgReader } from "../workers/framing.ts";
import type { Signal } from "../events/lifecycle.ts";
import type { ObjectFrame } from "../events/tracker.ts";
import type { Camera, CameraId, ObjectSettings } from "../types.ts";
import { qualifying, STATIONARY_MS, StationaryFilter, toHits, type Detection } from "./hits.ts";
import { parseDetectorMsg } from "./protocol.ts";
import { FrameQueue } from "./queue.ts";
import { createObjectDetection } from "./service.ts";

const det = (label: string, score: number, box: [number, number, number, number] = [0.4, 0.4, 0.6, 0.6]): Detection => ({ label, score, box });

test("qualifying boxes are watched labels above the threshold whose centre is outside every mask, and hits keep the best one per label", () => {
  const detect = { labels: ["person", "car"], objectScore: 0.5, masks: [{ points: [[0, 0], [0.3, 0], [0.3, 0.3], [0, 0.3]] as [number, number][] }], objectMasks: [] };
  const boxes = qualifying(
    [det("person", 0.6), det("person", 0.9), det("dog", 0.99), det("car", 0.4), det("car", 0.95, [0.05, 0.05, 0.2, 0.2]), det("car", 0.7, [0.1, 0.1, 0.9, 0.9])],
    detect,
  );
  expect(boxes).toEqual([det("person", 0.6), det("person", 0.9), det("car", 0.7, [0.1, 0.1, 0.9, 0.9])]);
  expect(toHits(boxes)).toEqual([
    { label: "person", score: 0.9 },
    { label: "car", score: 0.7 },
  ]);
});

test("object-only zones drop objects centred inside them, like the motion masks do", () => {
  const parkingBay = { points: [[0, 0.5], [0.4, 0.5], [0.4, 1], [0, 1]] as [number, number][] };
  const detect = { labels: ["person", "car"], objectScore: 0.5, masks: [], objectMasks: [parkingBay] };
  const boxes = qualifying([det("car", 0.9, [0.05, 0.6, 0.35, 0.9]), det("car", 0.8, [0.6, 0.6, 0.9, 0.9]), det("person", 0.7, [0.1, 0.55, 0.2, 0.95])], detect);
  expect(boxes).toEqual([det("car", 0.8, [0.6, 0.6, 0.9, 0.9])]);
  expect(toHits(boxes)).toEqual([{ label: "car", score: 0.8 }]);
});

test("a car parked in the same spot stops counting, while one that moves or a new arrival still counts", () => {
  const f = new StationaryFilter();
  const parked = (jitter = 0) => det("car", 0.9, [0.1 + jitter, 0.5, 0.3 + jitter, 0.7]);
  expect(f.moving([parked()], 0)).toHaveLength(1);
  expect(f.moving([parked(0.01)], 1_000)).toHaveLength(1);
  // 隔了很久的下一次事件：別處有人在動，停著的車不再算
  const person = det("person", 0.8, [0.6, 0.2, 0.7, 0.6]);
  expect(f.moving([parked(0.005), person], STATIONARY_MS + 60_000)).toEqual([person]);
  // 同一個位置旁邊開來另一台車
  const other = det("car", 0.9, [0.5, 0.5, 0.7, 0.7]);
  expect(f.moving([parked(), other], STATIONARY_MS + 61_000)).toEqual([other]);
  // 停著的車開走了：框移到別處就算
  const leaving = det("car", 0.9, [0.25, 0.5, 0.45, 0.7]);
  expect(f.moving([leaving], STATIONARY_MS + 62_000)).toEqual([leaving]);
});

test("a stationary spot is forgotten after it goes unseen for several recognitions", () => {
  const f = new StationaryFilter();
  const car = det("car", 0.9, [0.1, 0.5, 0.3, 0.7]);
  f.moving([car], 0);
  expect(f.moving([car], STATIONARY_MS)).toEqual([]);
  for (let i = 1; i <= 10; i++) f.moving([], STATIONARY_MS + i * 1_000);
  // 同一個位置又出現一台車，是新來的
  expect(f.moving([car], STATIONARY_MS + 20_000)).toEqual([car]);
});

test("the queue drops frames that waited more than a second", () => {
  const q = new FrameQueue<string>();
  q.push("old", 0);
  q.push("fresh", 900);
  expect(q.take(1500)).toBe("fresh");
  expect(q.dropped).toBe(1);
  expect(q.take(1500)).toBeNull();
});

test("detector messages are parsed defensively", () => {
  expect(parseDetectorMsg("nope")).toBeNull();
  expect(parseDetectorMsg(JSON.stringify({ type: "result", id: 3, ms: 12, detections: [{ label: "cat", score: 0.8, box: [0, 0, 1, 1] }, { label: "x" }] }))).toEqual({
    type: "result",
    id: 3,
    ms: 12,
    detections: [{ label: "cat", score: 0.8, box: [0, 0, 1, 1] }],
  });
  expect(parseDetectorMsg(JSON.stringify({ type: "status", state: "ready", device: "gpu", model: {} }))).toBeNull();
});

test("the share of inference that actually ran on the CPU comes from the detector's placement", () => {
  const results = [
    { device: "intel:GPU.0", kind: "intel", name: "UHD 630", ok: true, fps: 30, placement: { OpenVINOExecutionProvider: 0.38, CPUExecutionProvider: 0.62 } },
    { device: "nvidia:GPU-1", kind: "nvidia", name: "RTX", ok: true, fps: 300, placement: { CUDAExecutionProvider: 1 } },
    { device: "cpu", kind: "cpu", name: "CPU", ok: true, fps: 20, placement: { CPUExecutionProvider: 1 } },
    { device: "intel:GPU.1", kind: "intel", name: "Arc", ok: false, reason: "Arc沒有實際執行這個模型", error: "NotOnDevice", placement: { CPUExecutionProvider: 1 } },
    { device: "nvidia:GPU-2", kind: "nvidia", name: "Old", ok: true, fps: 50 },
  ];
  const msg = parseDetectorMsg(JSON.stringify({ type: "bench-result", cancelled: false, results }));
  if (msg?.type !== "bench-result") throw new Error("not parsed");
  expect(msg.results.map((r) => r.cpuShare)).toEqual([0.62, 0, undefined, 1, undefined]);
  expect(msg.results[3]!.reason).toBe("Arc沒有實際執行這個模型");
});

const cam = "cam1" as CameraId;
const camera = (objectMode: "off" | "annotate" | "filter"): Camera => ({
  id: cam,
  position: 0,
  groupId: null,
  createdAt: 0,
  updatedAt: 0,
  config: {
    name: "前門",
    enabled: true,
    connection: { type: "rtsp", mainUrl: "rtsp://x/y", transport: "tcp" },
    record: { enabled: false, audio: false, direct: false },
    detect: { ...DEFAULT_DETECT, labels: ["person"], objectMode },
  },
});

/** 用 Bun 假裝成 detector：連上 socket、照協定回訊息 */
async function harness(mode: "off" | "annotate" | "filter" = "annotate") {
  const settings: { objects: ObjectSettings; devices: { objects: string } } = { objects: { enabled: true, model: "builtin", fps: 2 }, devices: { objects: "auto" } };
  const signals: { signal: Signal; frame?: ObjectFrame }[] = [];
  let t = 10_000;
  const socketPath = join(mkdtempSync("/tmp/cnvr-"), "d.sock");
  const objects = createObjectDetection({
    env: { detectorPython: "python3", dataDir: mkdtempSync(join(tmpdir(), "cnvr-objects-")) },
    settings: () => settings,
    cameras: () => [camera(mode)],
    events: { signal: (_id, signal, _cooldown, frame) => signals.push({ signal, frame }), wantsObjects: () => true },
    socketPath,
    now: () => t,
  });
  const [spec] = objects.workerSpecs();
  const frames: { id: number; jpeg: Uint8Array }[] = [];
  const commands: Record<string, unknown>[] = [];
  const reader = new MsgReader();
  const client = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, chunk) {
        for (const m of reader.push(chunk)) {
          if (m.kind === 1) {
            commands.push(JSON.parse(new TextDecoder().decode(m.payload)));
            continue;
          }
          const view = new DataView(m.payload.buffer, m.payload.byteOffset);
          frames.push({ id: view.getUint32(0), jpeg: m.payload.slice(4) });
        }
      },
    },
  });
  const send = (msg: object) => {
    const body = new TextEncoder().encode(JSON.stringify(msg));
    const out = new Uint8Array(5 + body.length);
    out[0] = 1;
    new DataView(out.buffer).setUint32(1, body.length);
    out.set(body, 5);
    client.write(out);
  };
  const settle = () => Bun.sleep(30);
  const ready = async () => {
    send({
      type: "status",
      state: "ready",
      device: "cpu",
      deviceId: "cpu",
      deviceName: "Test CPU",
      devices: [{ id: "cpu", kind: "cpu", name: "Test CPU" }, { id: "nvidia:GPU-1", kind: "nvidia", name: "GTX 1650" }],
      fallback: { reason: "這個映像沒有 Nvidia 推論元件", detail: "x" },
      model: { file: "yolox_tiny.onnx", format: "yolox", input: [416, 416], classes: ["person", "package"], titles: ["person", "Package"] },
      loadMs: 50,
      providers: ["CPUExecutionProvider"],
      threads: 4,
    });
    await settle();
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const route = objects.routes().find((r) => r.method === method && r.path === path)!;
    const req = new Request(`http://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return (await route.handler({ req, url: new URL(req.url), params: {}, principal: null, ip: "127.0.0.1" })) as Response;
  };
  return { objects, spec: spec!, send, settle, ready, frames, commands, signals, client, settings, call, advance: (ms: number) => (t += ms), now: () => t };
}

test("frames go to the detector one at a time and results become object signals with their frame", async () => {
  const h = await harness();
  await h.settle();
  h.objects.offerJpeg(cam, new Uint8Array([1]), h.now());
  await h.settle();
  expect(h.frames).toEqual([]); // 還沒 ready 不送
  await h.ready();
  expect(h.objects.status()).toMatchObject({ state: "ready", device: { id: "cpu", name: "Test CPU" }, fallback: { reason: "這個映像沒有 Nvidia 推論元件" } });
  h.objects.offerJpeg(cam, new Uint8Array([2]), h.now());
  h.advance(500);
  h.objects.offerJpeg(cam, new Uint8Array([3]), h.now());
  await h.settle();
  expect(h.frames.map((f) => [...f.jpeg])).toEqual([[2]]);
  h.send({ type: "result", id: h.frames[0]!.id, ms: 11.5, detections: [{ label: "person", score: 0.8, box: [0.4, 0.4, 0.6, 0.6] }, { label: "cat", score: 0.9, box: [0, 0, 1, 1] }] });
  await h.settle();
  expect(h.signals).toEqual([{ signal: { type: "objects", at: 10_000, hits: [{ label: "person", score: 0.8 }] }, frame: { jpeg: new Uint8Array([2]), boxes: [{ label: "person", score: 0.8, box: [0.4, 0.4, 0.6, 0.6] }] } }]);
  expect(h.frames.map((f) => [...f.jpeg])).toEqual([[2], [3]]);
  expect(h.objects.status().latencyMs).toEqual({ last: 11.5, avg: 11.5, max: 11.5 });
  h.client.end();
  await h.objects.stop();
});

test("a frame that waited more than a second behind a slow one is dropped and counted", async () => {
  const h = await harness();
  await h.ready();
  h.objects.offerJpeg(cam, new Uint8Array([1]), h.now());
  h.advance(500);
  h.objects.offerJpeg(cam, new Uint8Array([2]), h.now());
  await h.settle();
  h.advance(1_500);
  h.objects.offerJpeg(cam, new Uint8Array([3]), h.now());
  h.send({ type: "result", id: h.frames[0]!.id, ms: 1500, detections: [] });
  await h.settle();
  expect(h.frames.map((f) => [...f.jpeg])).toEqual([[1], [3]]);
  expect(h.objects.status().dropped).toBe(1);
  h.client.end();
  await h.objects.stop();
});

test("filter mode is only in force while the detector is ready", async () => {
  const h = await harness("filter");
  expect(h.objects.filterWindow(cam)).toBeNull();
  await h.ready();
  expect(h.objects.filterWindow(cam)).toBe(3_000);
  h.settings.objects.fps = 0.5;
  expect(h.objects.filterWindow(cam)).toBe(5_000);
  h.client.end();
  await h.settle();
  expect(h.objects.status().state).toBe("starting");
  expect(h.objects.filterWindow(cam)).toBeNull();
  await h.objects.stop();
});

test("a model error is reported and keeps the worker from being judged stalled while heartbeats come", async () => {
  const h = await harness();
  h.send({ type: "status", state: "error", error: "看不懂模型的輸出形狀 [1, 1000]" });
  await h.settle();
  expect(h.objects.status()).toMatchObject({ state: "error", error: "看不懂模型的輸出形狀 [1, 1000]" });
  h.advance(5_000);
  h.send({ type: "heartbeat", busyMs: null });
  await h.settle();
  expect(await h.spec.stall!.healthy()).toBe(true);
  h.advance(11_000);
  expect(await h.spec.stall!.healthy()).toBe(false);
  h.client.end();
  await h.objects.stop();
});

test("an inference stuck for more than 10 seconds is a stall", async () => {
  const h = await harness();
  await h.ready();
  h.send({ type: "heartbeat", busyMs: 10_500 });
  await h.settle();
  expect(await h.spec.stall!.healthy()).toBe(false);
  h.client.end();
  await h.objects.stop();
});

test("frames are thinned to the recognition rate per camera", async () => {
  const h = await harness();
  await h.ready();
  h.settings.objects.fps = 1;
  for (let i = 0; i < 6; i++) {
    h.objects.offerJpeg(cam, new Uint8Array([i]), h.now());
    await h.settle();
    const last = h.frames.at(-1);
    if (last) h.send({ type: "result", id: last.id, ms: 5, detections: [] });
    await h.settle();
    h.advance(500);
  }
  expect(h.frames.map((f) => f.jpeg[0])).toEqual([0, 2, 4]);
  expect(h.objects.jpegFps(camera("annotate"))).toBe(1);
  h.settings.objects.fps = 3;
  expect(h.objects.jpegFps(camera("annotate"))).toBe(3);
  h.client.end();
  await h.objects.stop();
});

test("a speed test pauses recognition, waits for the frame in hand, and converts results to cameras", async () => {
  const h = await harness("filter");
  await h.ready();
  h.objects.offerJpeg(cam, new Uint8Array([1]), h.now());
  await h.settle();
  const res = await h.call("POST", "/api/objects/benchmark", { devices: ["cpu", "nvidia:GPU-1"], seconds: 5 });
  expect(res.status).toBe(202);
  await h.settle();
  expect(h.commands).toEqual([]); // 手上那張還沒做完
  expect(h.objects.status().paused).toBe("benchmark");
  expect(h.objects.filterWindow(cam)).toBeNull();
  h.send({ type: "result", id: h.frames[0]!.id, ms: 5, detections: [] });
  await h.settle();
  expect(h.commands).toEqual([{ type: "bench", devices: ["cpu", "nvidia:GPU-1"], seconds: 5 }]);
  h.advance(600);
  h.objects.offerJpeg(cam, new Uint8Array([2]), h.now());
  await h.settle();
  expect(h.frames).toHaveLength(1); // 測速中不送畫面
  h.send({ type: "heartbeat", busyMs: 30_000, bench: true, gpu: null });
  await h.settle();
  expect(await h.spec.stall!.healthy()).toBe(true);
  h.send({ type: "bench-result", cancelled: false, results: [{ device: "cpu", kind: "cpu", name: "Test CPU", ok: true, fps: 40, msMean: 25 }, { device: "nvidia:GPU-1", kind: "nvidia", name: "GTX 1650", ok: true, fps: 200, msMean: 5 }] });
  await h.settle();
  const dto = (await (await h.call("GET", "/api/objects")).json()) as { benchmark: { state: string; results: { cameras: number }[]; verdict: { supported: number; state: string } } };
  // CPU 40 張/秒 × 0.5 ÷ 每台 2 次 = 10 台；GPU 200 × 0.8 ÷ 2 = 80 台
  expect(dto.benchmark.results.map((r) => r.cameras)).toEqual([10, 80]);
  expect(dto.benchmark.verdict).toMatchObject({ device: "cpu", supported: 10, state: "enough" });
  expect(h.objects.status().paused).toBeNull();
  h.client.end();
  await h.objects.stop();
});

test("labels come from the loaded model, with Chinese where known and the raw name otherwise", async () => {
  const h = await harness();
  await h.ready();
  const dto = (await (await h.call("GET", "/api/objects/labels")).json()) as { labels: unknown[]; common: string[]; known: boolean };
  expect(dto.labels).toEqual([
    { key: "person", zh: "人", en: "person" },
    { key: "package", zh: "包裹", en: "Package" },
  ]);
  expect(dto.common).toEqual(["person"]);
  h.client.end();
  await h.objects.stop();
});

test("disabled means no worker and 1 JPEG per second", async () => {
  const objects = createObjectDetection({
    env: { detectorPython: "python3", dataDir: mkdtempSync(join(tmpdir(), "cnvr-objects-")) },
    settings: () => ({ objects: { enabled: false, model: "builtin", fps: 2 }, devices: { objects: "auto" } }),
    cameras: () => [camera("annotate")],
    events: { signal: () => {}, wantsObjects: () => true },
  });
  expect(objects.workerSpecs()).toEqual([]);
  expect(objects.jpegFps(camera("annotate"))).toBe(1);
  expect(objects.status().state).toBe("off");
  await objects.stop();
});

test("the public config lists only labels in force, and a round trip keeps the saved choice", async () => {
  const { mergeCameraConfig, publicCameraConfig } = await import("./config.ts");
  const saved = camera("filter").config;
  expect(publicCameraConfig(saved, true).detect!.labels).toEqual(["person"]);
  expect(publicCameraConfig(saved, false).detect!.labels).toEqual([]);
  const off = { ...saved, detect: { ...saved.detect!, objectMode: "off" as const } };
  expect(publicCameraConfig(off, true).detect!.labels).toEqual([]);
  // 系統沒開：用戶端送回空的勾選與別的模式，三個欄位都沿用
  const echoed = { ...saved, detect: { ...saved.detect!, labels: [], objectMode: "annotate" as const, objectScore: 0.9 } };
  expect(mergeCameraConfig(echoed, saved, false).detect).toMatchObject({ labels: ["person"], objectMode: "filter", objectScore: 0.5 });
  // 這台改成不辨識：勾選沿用
  expect(mergeCameraConfig({ ...off, detect: { ...off.detect, labels: [] } }, saved, true).detect!.labels).toEqual(["person"]);
  expect(mergeCameraConfig({ ...saved, detect: { ...saved.detect!, labels: ["dog"] } }, saved, true).detect!.labels).toEqual(["dog"]);
});

test("the GPU card in system resources shows the recognition rate when it is the card in use", async () => {
  const h = await harness();
  h.send({
    type: "status",
    state: "ready",
    device: "nvidia",
    deviceId: "nvidia:GPU-1",
    deviceName: "GTX 1650",
    devices: [{ id: "cpu", kind: "cpu", name: "Test CPU" }, { id: "nvidia:GPU-1", kind: "nvidia", name: "GTX 1650", pci: "00000000:01:00.0" }],
    fallback: null,
    model: { file: "yolox_tiny.onnx", format: "yolox", input: [416, 416], classes: ["person"], titles: ["person"] },
  });
  await h.settle();
  expect(h.objects.gpuExtras({ id: "nvidia:0000:01:00.0", vendor: "nvidia" })).toEqual([{ label: "物件辨識", value: "每秒 0 張", labelMsg: msg("objects.gpuLabel"), valueMsg: msg("objects.gpuRate", { fps: 0 }) }]);
  expect(h.objects.gpuExtras({ id: "nvidia:0000:02:00.0", vendor: "nvidia" })).toEqual([]);
  expect(h.objects.gpuExtras({ id: "intel:0000:00:02.0", vendor: "intel" })).toEqual([]);
  h.client.end();
  await h.objects.stop();
});

test("detector 的原因帶 code 與 params；不認得的 code 當原文", () => {
  const err = parseDetectorMsg(JSON.stringify({ type: "status", state: "error", error: "找不到模型檔 a.onnx", code: "detector.modelFileMissing", params: { file: "a.onnx" } }));
  expect(err).toMatchObject({ type: "error", error: "找不到模型檔 a.onnx", errorMsg: { code: "detector.modelFileMissing", params: { file: "a.onnx" } } });
  const unknown = parseDetectorMsg(JSON.stringify({ type: "status", state: "error", error: "新的錯誤", code: "detector.fromTheFuture" }));
  expect(unknown).toMatchObject({ errorMsg: { code: "raw", params: { text: "新的錯誤" } } });
  const bench = parseDetectorMsg(JSON.stringify({ type: "bench-result", cancelled: false, results: [{ device: "intel:GPU.0", kind: "intel", ok: false, reason: "x", reasonMsg: { code: "detector.notOnDeviceBench", params: { device: "A", runtime: "OpenVINO" } }, error: "找不到這個裝置", errorMsg: { code: "detector.benchDeviceMissing" } }] }));
  expect(bench).toMatchObject({ results: [{ reasonMsg: { code: "detector.notOnDeviceBench" }, errorMsg: { code: "detector.benchDeviceMissing" } }] });
});
