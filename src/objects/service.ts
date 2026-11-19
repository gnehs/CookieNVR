import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Socket, UnixSocketListener } from "bun";
import builtinModel from "../../detector/builtin-model.json";
import type {
  BenchmarkDto,
  BenchmarkResultDto,
  GpuUsageDto,
  InferenceDeviceDto,
  ObjectLabelDto,
  ObjectLabelsDto,
  ObjectModelDto,
  ObjectsDto,
  ObjectsStatusDto,
} from "../api-types.ts";
import { detectConfigOf } from "../detect/config.ts";
import { MsgReader } from "../detect/protocol.ts";
import type { Env } from "../env.ts";
import type { EventTracker } from "../events/tracker.ts";
import { HttpError } from "../http/errors.ts";
import { asObject } from "../http/validate.ts";
import type { Camera, CameraId, DeviceRef, ObjectSettings, Route, WorkerSpec } from "../types.ts";
import { camerasSupported, DROP_WARN_RATIO, loadSample, verdict } from "./capacity.ts";
import { toHits, type Detection } from "./hits.ts";
import { COCO_LABELS, COMMON_LABELS, labelName } from "./labels.ts";
import { encodeFrame, encodeJson, KIND_JSON, parseDetectorMsg, type ReadyInfo } from "./protocol.ts";
import { FrameQueue } from "./queue.ts";

const DETECTOR_SCRIPT = join(import.meta.dir, "../../detector/main.py");
const BUILTIN_PATH = join(import.meta.dir, "../../detector/models", builtinModel.file);
export const BUILTIN_ID = "builtin";
/** 心跳每 2 秒一次；這麼久沒有任何訊息，或一張推論做了這麼久，就當卡死重啟（規格：10 秒） */
const STALL_MS = 10_000;
/** 程序啟動到連上 socket 的寬限 */
const STALL_GRACE_MS = 15_000;
/** GPU 第一次編譯模型可能很久，但不能無限等 */
const LOAD_LIMIT_MS = 180_000;
/** 測速最長（每個裝置最多 60 秒，加上載入） */
const BENCH_LIMIT_MS = 10 * 60_000;
const LATENCY_WINDOW = 50;
const DEVICE_CACHE_MS = 5 * 60_000;
/** JPEG 到得時間有抖動：比間隔少一點也算到了該送的時候 */
const THROTTLE_SLACK_MS = 100;

type Phase =
  | { tag: "off" }
  | { tag: "starting" }
  | { tag: "loading"; since: number }
  | { tag: "ready"; info: ReadyInfo }
  | { tag: "error"; message: string; detail: string | null; probe: unknown };

/** 測速：sent = 指令已送給 detector；還沒送是在等手上那張推論做完 */
type Bench = BenchmarkDto & { sent: boolean; devices: string[]; seconds: number };

interface Job {
  cameraId: CameraId;
  at: number;
  jpeg: Uint8Array;
}

export interface ObjectDetectionOptions {
  env: Pick<Env, "detectorPython" | "dataDir">;
  settings: () => { objects: ObjectSettings; devices: { objects: DeviceRef } };
  cameras: () => Camera[];
  events: Pick<EventTracker, "signal" | "wantsObjects">;
  /** Unix socket 路徑；macOS 限制約 104 字元，所以不放在 dataDir */
  socketPath?: string;
  now?: () => number;
  onError?: (scope: string, e: unknown) => void;
}

/** 給狀態頁的整機資源區塊用：推論程序的現況 */
export interface DetectorResources {
  state: ObjectsStatusDto["state"];
  device: InferenceDeviceDto | null;
  /** 最近 60 秒平均每秒推論幾張 */
  rateFps: number;
  queued: number;
  /** 最近 5 分鐘被丟掉的比例；畫面太少時為 null */
  dropRatio: number | null;
  processed: number;
  dropped: number;
  /** Nvidia 卡的使用率與顯示記憶體；其他裝置為 null */
  gpu: GpuUsageDto | null;
}

/** 診斷報告用 */
export interface ObjectsDiagnostics {
  settings: ObjectSettings;
  requested: DeviceRef;
  status: ObjectsStatusDto;
  ready: ReadyInfo | null;
  errorDetail: string | null;
  probe: unknown;
  queued: number;
  benchmark: BenchmarkDto | null;
  /** 每台最近一次辨識結果（信心 0.25 以上的原始類別，未套門檻與遮罩） */
  recent: { cameraId: CameraId; at: number; detections: { label: string; score: number }[] }[];
}

export interface ObjectDetection {
  workerSpecs(): WorkerSpec[];
  /** detect worker 每送來一張 JPEG 就交給它；需要時才排進推論佇列 */
  offerJpeg(cameraId: CameraId, jpeg: Uint8Array, at: number): void;
  /** 這台現在是否要等辨識才建立事件：回傳等待期限（毫秒），不等為 null（沒開過濾模式或 detector 不能用） */
  filterWindow(cameraId: CameraId): number | null;
  /** detect worker 每秒輸出幾張 JPEG */
  jpegFps(camera: Camera): number;
  status(): ObjectsStatusDto;
  resources(): DetectorResources;
  diagnostics(): ObjectsDiagnostics;
  routes(): Route[];
  stop(): Promise<void>;
}

/** 過濾模式等辨識的期限：至少 3 秒，頻率很低時要能等到連續 2 張 */
export const filterWindowMs = (fps: number) => Math.max(3_000, Math.round(2_000 / fps + 1_000));

export function createObjectDetection(opts: ObjectDetectionOptions): ObjectDetection {
  const now = opts.now ?? Date.now;
  const socketPath = opts.socketPath ?? `/tmp/cookienvr-${process.pid}-detector.sock`;
  const modelsDir = join(opts.env.dataDir, "models");
  const benchFile = join(opts.env.dataDir, "detector-benchmark.json");
  const report = (e: unknown) => opts.onError?.("detector", e);

  let phase: Phase = { tag: "off" };
  let listener: UnixSocketListener<undefined> | null = null;
  let conn: Socket<undefined> | null = null;
  let reader = new MsgReader();
  /** socket 寫不完的部分，等 drain 再送 */
  let unsent: Uint8Array | null = null;
  let lastMsgAt = 0;
  let busyMs: number | null = null;
  let gpu: GpuUsageDto | null = null;
  const queue = new FrameQueue<Job>();
  let inFlight: { id: number; job: Job; sentAt: number } | null = null;
  let nextId = 1;
  let processed = 0;
  const processedAt: number[] = [];
  const droppedAt: number[] = [];
  const latencies: number[] = [];
  const lastQueued = new Map<CameraId, number>();
  const recent = new Map<CameraId, ObjectsDiagnostics["recent"][number]>();
  /** 每個模型載入後回報的類別；自備模型沒載入過就不知道 */
  const classesByModel = new Map<string, { classes: string[]; titles: string[] }>();
  let deviceCache: { at: number; devices: InferenceDeviceDto[]; unavailable: ObjectsDto["unavailable"] } | null = null;
  let deviceProbe: Promise<void> | null = null;
  let bench: Bench | null = loadBench();
  const dec = new TextDecoder();

  const cfg = () => opts.settings().objects;
  const enabled = () => cfg().enabled;
  const benchRunning = () => bench?.state === "running";
  const cameraOf = (id: CameraId) => opts.cameras().find((c) => c.id === id) ?? null;

  function objectModeOf(camera: Camera) {
    const d = detectConfigOf(camera.config);
    return camera.config.enabled && d.enabled ? d.objectMode : "off";
  }

  function loadBench(): Bench | null {
    try {
      const saved = JSON.parse(readFileSync(benchFile, "utf8")) as BenchmarkDto;
      return { ...saved, state: saved.state === "running" ? "failed" : saved.state, sent: true, devices: [], seconds: 0 };
    } catch {
      return null;
    }
  }

  function saveBench(): void {
    if (!bench) return;
    const { sent: _s, devices: _d, seconds: _x, ...dto } = bench;
    const tmp = `${benchFile}.tmp`;
    void writeFile(tmp, JSON.stringify(dto))
      .then(() => rename(tmp, benchFile))
      .catch(report);
  }

  function finishBench(state: BenchmarkDto["state"], error: string | null, results?: BenchmarkResultDto[]): void {
    if (!bench) return;
    const fps = bench.perCameraFps;
    bench = {
      ...bench,
      state,
      error,
      finishedAt: now(),
      progress: null,
      results: (results ?? bench.results).map((r) => (r.ok && r.fps ? { ...r, cameras: camerasSupported(r.fps, r.kind, fps) } : r)),
    };
    saveBench();
  }

  function write(bytes: Uint8Array): void {
    if (!conn) return;
    if (unsent) {
      const merged = new Uint8Array(unsent.length + bytes.length);
      merged.set(unsent);
      merged.set(bytes, unsent.length);
      unsent = merged;
      return;
    }
    const n = conn.write(bytes);
    if (n < bytes.length) unsent = bytes.slice(Math.max(0, n));
  }

  /** 測速指令要等手上那張做完才送，detector 一次只做一件事 */
  function maybeSendBench(): boolean {
    if (!bench || bench.state !== "running" || bench.sent) return false;
    if (inFlight || !conn) return true;
    bench.sent = true;
    write(encodeJson({ type: "bench", devices: bench.devices, seconds: bench.seconds }));
    return true;
  }

  function pump(): void {
    if (maybeSendBench() || benchRunning()) return;
    if (inFlight || !conn || phase.tag !== "ready") return;
    const before = queue.dropped;
    const job = queue.take(now());
    for (let i = before; i < queue.dropped; i++) droppedAt.push(now());
    if (!job) return;
    const id = nextId++;
    inFlight = { id, job, sentAt: now() };
    write(encodeFrame(id, job.jpeg));
  }

  function trim(list: number[], maxAgeMs: number): void {
    const t = now();
    while (list.length && t - list[0]! > maxAgeMs) list.shift();
  }

  function onResult(id: number, ms: number, detections: Detection[] | null): void {
    if (!inFlight || inFlight.id !== id) return;
    const { job } = inFlight;
    inFlight = null;
    if (detections) {
      processed++;
      processedAt.push(now());
      trim(processedAt, 300_000);
      latencies.push(ms);
      if (latencies.length > LATENCY_WINDOW) latencies.shift();
      recent.set(job.cameraId, { cameraId: job.cameraId, at: job.at, detections: detections.map((d) => ({ label: d.label, score: d.score })) });
      const camera = cameraOf(job.cameraId);
      if (camera && objectModeOf(camera) !== "off") {
        const detect = detectConfigOf(camera.config);
        opts.events.signal(job.cameraId, { type: "objects", at: job.at, hits: toHits(detections, detect) }, detect.cooldownSec * 1000, job.jpeg);
      }
    }
    pump();
  }

  function onMessage(raw: string): void {
    lastMsgAt = now();
    const msg = parseDetectorMsg(raw);
    if (!msg) return;
    switch (msg.type) {
      case "loading":
        phase = { tag: "loading", since: now() };
        break;
      case "ready":
        phase = { tag: "ready", info: msg.info };
        classesByModel.set(cfg().model, { classes: msg.info.model.classes, titles: msg.info.model.titles });
        pump();
        break;
      case "error":
        phase = { tag: "error", message: msg.error, detail: msg.detail, probe: msg.probe };
        queue.clear();
        break;
      case "heartbeat":
        busyMs = msg.busyMs;
        gpu = msg.gpu;
        break;
      case "result":
        onResult(msg.id, msg.ms, msg.detections);
        break;
      case "result-error":
        report(new Error(`frame ${msg.id}: ${msg.error}`));
        onResult(msg.id, 0, null);
        break;
      case "bench-progress":
        if (benchRunning()) bench!.progress = { device: msg.device, index: msg.index, total: msg.total, fraction: msg.fraction };
        break;
      case "bench-result":
        if (benchRunning()) finishBench(msg.cancelled ? "cancelled" : "done", null, msg.results);
        pump();
        break;
    }
  }

  function disconnected(): void {
    conn = null;
    unsent = null;
    inFlight = null;
    busyMs = null;
    gpu = null;
    queue.clear();
    reader = new MsgReader();
    phase = enabled() ? { tag: "starting" } : { tag: "off" };
    if (benchRunning()) finishBench("failed", "推論程序重新啟動，測速中斷");
  }

  function ensureListener(): void {
    if (listener) return;
    rmSync(socketPath, { force: true });
    listener = Bun.listen<undefined>({
      unix: socketPath,
      socket: {
        open(socket) {
          // 重啟時舊程序可能還沒斷線：只認最新的連線
          conn?.end();
          disconnected();
          conn = socket;
          lastMsgAt = now();
        },
        data(socket, chunk) {
          if (socket !== conn) return;
          for (const msg of reader.push(chunk)) if (msg.kind === KIND_JSON) onMessage(dec.decode(msg.payload));
        },
        drain(socket) {
          if (socket !== conn || !unsent) return;
          const rest = unsent;
          unsent = null;
          write(rest);
        },
        close(socket) {
          if (socket === conn) disconnected();
        },
        error(socket, e) {
          report(e);
          if (socket === conn) disconnected();
        },
      },
    });
  }

  function modelPath(id: string): string {
    return id === BUILTIN_ID ? BUILTIN_PATH : join(modelsDir, id);
  }

  function healthy(): boolean {
    const t = now();
    if (t - lastMsgAt > STALL_MS) return false;
    if (benchRunning()) return t - bench!.startedAt < BENCH_LIMIT_MS;
    if (busyMs !== null && busyMs > STALL_MS) return false;
    if (inFlight && t - inFlight.sentAt > STALL_MS) return false;
    return !(phase.tag === "loading" && t - phase.since > LOAD_LIMIT_MS);
  }

  function workerSpecs(): WorkerSpec[] {
    const s = opts.settings();
    if (!s.objects.enabled) {
      if (phase.tag !== "off" && !conn) phase = { tag: "off" };
      return [];
    }
    ensureListener();
    if (phase.tag === "off") phase = { tag: "starting" };
    return [
      {
        id: "detector",
        kind: "detector",
        cmd: [opts.env.detectorPython, DETECTOR_SCRIPT, "--socket", socketPath, "--device", s.devices.objects, "--model", modelPath(s.objects.model)],
        env: { OPENVINO_CACHE_DIR: join(opts.env.dataDir, "detector-cache"), PYTHONUNBUFFERED: "1" },
        stall: { intervalMs: 2_000, graceMs: STALL_GRACE_MS, healthy },
      },
    ];
  }

  /** detector 沒在跑時，另外執行一次 `main.py --list-devices` 取得裝置清單 */
  function probeDevices(): Promise<void> {
    if (deviceProbe) return deviceProbe;
    deviceProbe = (async () => {
      const proc = Bun.spawn([opts.env.detectorPython, DETECTOR_SCRIPT, "--list-devices"], { stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => proc.kill(), 30_000);
      try {
        const out = JSON.parse(await new Response(proc.stdout).text()) as { devices?: unknown[]; unavailable?: Record<string, { reason?: string } | null> };
        const devices = (out.devices ?? []).flatMap((d) => {
          const v = d as Partial<InferenceDeviceDto>;
          return typeof v.id === "string" && (v.kind === "cpu" || v.kind === "intel" || v.kind === "nvidia") ? [{ id: v.id, kind: v.kind, name: String(v.name ?? v.id) }] : [];
        });
        const reason = (k: string) => out.unavailable?.[k]?.reason ?? null;
        deviceCache = { at: now(), devices, unavailable: { intel: reason("intel"), nvidia: reason("nvidia") } };
      } catch (e) {
        report(e);
        deviceCache = { at: now(), devices: [{ id: "cpu", kind: "cpu", name: "CPU" }], unavailable: { intel: null, nvidia: null } };
      } finally {
        clearTimeout(timer);
        deviceProbe = null;
      }
    })();
    return deviceProbe;
  }

  async function devices(): Promise<{ devices: InferenceDeviceDto[]; unavailable: ObjectsDto["unavailable"] }> {
    if (!deviceCache || now() - deviceCache.at > DEVICE_CACHE_MS) await probeDevices();
    const live = phase.tag === "ready" ? phase.info.devices : null;
    return { devices: live?.length ? live : deviceCache!.devices, unavailable: deviceCache!.unavailable };
  }

  function listModels(): ObjectModelDto[] {
    const builtin: ObjectModelDto = { id: BUILTIN_ID, name: `${builtinModel.name}（內建）`, builtin: true, sizeBytes: builtinModel.bytes };
    let files: string[] = [];
    try {
      files = readdirSync(modelsDir).filter((f) => f.toLowerCase().endsWith(".onnx") && !f.startsWith("."));
    } catch {
      // 資料夾還不存在
    }
    const user = files.sort().map((f): ObjectModelDto => {
      let size: number | null = null;
      try {
        size = statSync(join(modelsDir, f)).size;
      } catch {}
      return { id: f, name: f, builtin: false, sizeBytes: size };
    });
    return [builtin, ...user];
  }

  function labels(): ObjectLabelsDto {
    const model = cfg().model;
    const known = classesByModel.get(model);
    const list: ObjectLabelDto[] = known
      ? known.classes.map((key, i) => ({ key, zh: labelName(key), en: known.titles[i] ?? key }))
      : COCO_LABELS.map(([key, zh, en]) => ({ key, zh, en }));
    const keys = new Set(list.map((l) => l.key));
    return { labels: list, common: COMMON_LABELS.filter((k) => keys.has(k)), model, known: known !== undefined || model === BUILTIN_ID };
  }

  const objectCameras = () => opts.cameras().filter((c) => objectModeOf(c) !== "off").length;

  function benchDto(): BenchmarkDto | null {
    if (!bench) return null;
    const { sent: _s, devices: _d, seconds: _x, ...dto } = bench;
    const known = new Set((phase.tag === "ready" ? phase.info.devices : (deviceCache?.devices ?? [])).map((d) => d.id));
    const tested = dto.results.filter((r) => r.ok);
    const stale = dto.model !== cfg().model || (known.size > 0 && tested.length > 0 && !tested.some((r) => known.has(r.device)));
    const current = phase.tag === "ready" ? phase.info.device.id : null;
    const mine = tested.find((r) => r.device === current) ?? null;
    const v = mine?.fps ? verdict(mine.fps, mine.kind, cfg().fps, objectCameras()) : null;
    return { ...dto, stale, verdict: v && mine ? { device: mine.device, ...v } : null };
  }

  function warningOf(dropRatio: number | null, b: BenchmarkDto | null): string | null {
    if (dropRatio !== null && dropRatio >= DROP_WARN_RATIO) {
      return `最近有 ${Math.round(dropRatio * 100)}% 的畫面來不及辨識。可以降低辨識頻率，或改用更快的裝置。`;
    }
    if (b && !b.stale && b.verdict?.state === "partial") {
      return `開了物件辨識的 ${b.verdict.cameras} 台攝影機同時有動作時會來不及，這台機器大約能同時處理 ${b.verdict.supported} 台。可以降低辨識頻率，或改用更快的裝置。`;
    }
    return null;
  }

  function status(): ObjectsStatusDto {
    const s = opts.settings();
    const ready = phase.tag === "ready" ? phase.info : null;
    const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const load = loadSample(processedAt, droppedAt, now());
    return {
      state: s.objects.enabled ? phase.tag : "off",
      requested: s.devices.objects,
      device: ready?.device ?? null,
      fallback: ready?.fallback ?? null,
      error: phase.tag === "error" ? phase.message : null,
      model: {
        id: s.objects.model,
        name: s.objects.model === BUILTIN_ID ? builtinModel.name : s.objects.model,
        format: ready?.model.format ?? null,
        input: ready?.model.input ?? null,
      },
      latencyMs: latencies.length ? { last: latencies.at(-1)!, avg: Math.round(avg * 10) / 10, max: Math.max(...latencies) } : null,
      processed,
      dropped: queue.dropped,
      rateFps: load.rateFps,
      dropRatio: load.dropRatio,
      paused: benchRunning() ? "benchmark" : null,
      warning: s.objects.enabled && phase.tag === "ready" ? warningOf(load.dropRatio, benchDto()) : null,
      gpu,
    };
  }

  function startBench(body: unknown): BenchmarkDto {
    if (phase.tag !== "ready") throw new HttpError(409, "物件辨識還沒準備好，開啟並等它載入完成後再測速");
    if (benchRunning()) throw new HttpError(409, "測速正在進行中");
    const o = body === undefined || body === null ? {} : asObject(body);
    const known = phase.info.devices.map((d) => d.id);
    const wanted = Array.isArray(o.devices) ? o.devices.filter((d): d is string => typeof d === "string") : [];
    const unknown = wanted.filter((d) => !known.includes(d));
    if (unknown.length) throw new HttpError(400, `找不到這些裝置：${unknown.join("、")}`);
    const seconds = typeof o.seconds === "number" && Number.isFinite(o.seconds) ? Math.min(60, Math.max(3, o.seconds)) : 10;
    bench = {
      state: "running",
      startedAt: now(),
      finishedAt: null,
      model: cfg().model,
      perCameraFps: cfg().fps,
      progress: null,
      results: [],
      error: null,
      stale: false,
      verdict: null,
      sent: false,
      devices: wanted.length ? wanted : [phase.info.device.id],
      seconds,
    };
    pump();
    return benchDto()!;
  }

  function cancelBench(): BenchmarkDto | null {
    if (!benchRunning()) return benchDto();
    if (bench!.sent) write(encodeJson({ type: "bench-cancel" }));
    else finishBench("cancelled", null);
    return benchDto();
  }

  const routes: Route[] = [
    {
      method: "GET",
      path: "/api/objects",
      access: "admin",
      async handler() {
        const d = await devices();
        return Response.json({ status: status(), models: listModels(), modelsDir, devices: d.devices, unavailable: d.unavailable, benchmark: benchDto() } satisfies ObjectsDto);
      },
    },
    { method: "GET", path: "/api/objects/labels", access: "user", handler: () => Response.json(labels()) },
    {
      method: "POST",
      path: "/api/objects/benchmark",
      access: "admin",
      async handler({ req }) {
        const text = await req.text();
        let body: unknown;
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          throw new HttpError(400, "請求內容不是 JSON");
        }
        return Response.json(startBench(body), { status: 202 });
      },
    },
    { method: "DELETE", path: "/api/objects/benchmark", access: "admin", handler: () => Response.json(cancelBench()) },
  ];

  return {
    workerSpecs,
    offerJpeg(cameraId, jpeg, at) {
      if (phase.tag !== "ready" || benchRunning() || !opts.events.wantsObjects(cameraId)) return;
      const camera = cameraOf(cameraId);
      if (!camera || objectModeOf(camera) === "off") return;
      const last = lastQueued.get(cameraId) ?? 0;
      if (at - last < 1000 / cfg().fps - THROTTLE_SLACK_MS) return;
      lastQueued.set(cameraId, at);
      const before = queue.dropped;
      queue.push({ cameraId, jpeg, at }, at);
      for (let i = before; i < queue.dropped; i++) droppedAt.push(at);
      trim(droppedAt, 300_000);
      pump();
    },
    filterWindow(cameraId) {
      if (!enabled() || phase.tag !== "ready" || benchRunning()) return null;
      const camera = cameraOf(cameraId);
      return camera !== null && objectModeOf(camera) === "filter" ? filterWindowMs(cfg().fps) : null;
    },
    jpegFps(camera) {
      return enabled() && objectModeOf(camera) !== "off" ? Math.min(5, Math.max(1, Math.ceil(cfg().fps))) : 1;
    },
    status,
    resources() {
      const st = status();
      return { state: st.state, device: st.device, rateFps: st.rateFps, queued: queue.length, dropRatio: st.dropRatio, processed, dropped: queue.dropped, gpu };
    },
    diagnostics: () => ({
      settings: cfg(),
      requested: opts.settings().devices.objects,
      status: status(),
      ready: phase.tag === "ready" ? phase.info : null,
      errorDetail: phase.tag === "error" ? phase.detail : null,
      probe: phase.tag === "ready" ? phase.info.probe : phase.tag === "error" ? phase.probe : null,
      queued: queue.length,
      benchmark: benchDto(),
      recent: [...recent.values()],
    }),
    routes: () => routes,
    async stop() {
      conn?.end();
      listener?.stop(true);
      listener = null;
      rmSync(socketPath, { force: true });
    },
  };
}
