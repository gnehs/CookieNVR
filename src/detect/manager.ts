import { mkdirSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DetectFrameState, MotionSampleDto } from "../api-types.ts";
import type { Env } from "../env.ts";
import type { EventTracker } from "../events/tracker.ts";
import { HttpError } from "../http/errors.ts";
import { queuedStream } from "../stream/queued-stream.ts";
import type { Camera, CameraId, DetectConfig, Route, WorkerSpec } from "../types.ts";
import type { HwFailure } from "../hwcodec/commands.ts";
import type { DecodePlan } from "../hwcodec/plan.ts";
import { HW_DECODE_ENV } from "./command.ts";
import { detectConfigOf, usesOnvif, usesPixel } from "./config.ts";
import { createOnvifSources, type OnvifSourceStatus } from "./onvif-source.ts";
import { chunksOf, MsgKind, MsgReader, type DecodeReport, type DetectControl, type FrameResult } from "./protocol.ts";

const WORKER_SCRIPT = join(import.meta.dir, "worker.ts");
const TICK_MS = 500;
/** 這麼久沒有新畫面，worker 以 stall 重啟（規格：15 秒） */
const STALL_MS = 15_000;
/** 第一次連線（RTSP 交握＋探測）要的時間 */
const STALL_GRACE_MS = 20_000;
/** 比這更舊的快照不提供，視為連不上 */
const SNAPSHOT_MAX_AGE_MS = 30_000;
/** 還沒有畫面時，快照請求等第一張的上限 */
const SNAPSHOT_WAIT_MS = 5_000;
const PING_MS = 20_000;

export interface DetectionOptions {
  env: Pick<Env, "ffmpegBin">;
  /** 控制檔目錄，每台一個 `<id>.json` */
  controlDir: string;
  events: EventTracker;
  /** detect worker 讀的 RTSP 網址（轉發層的子碼流，沒有子碼流用主碼流）；停用的攝影機回 null */
  sourceUrl(camera: Camera): string | null;
  /** 鏡頭移動中或剛停下 */
  isBusy(id: CameraId): boolean;
  /** 每台每秒輸出幾張 JPEG（1 到 5）；開了物件辨識的攝影機依辨識頻率，其餘 1 張 */
  jpegFps?: (camera: Camera) => number;
  /** 這台用哪張卡解碼；沒給就一律 CPU */
  decodePlan?: (camera: Camera) => DecodePlan;
  /** 每張新的 JPEG（快照與縮圖之外的用途，例如物件辨識） */
  onJpeg?: (id: CameraId, jpeg: Uint8Array<ArrayBuffer>, at: number) => void;
  fetch?: typeof fetch;
  now?: () => number;
  onError?: (scope: string, e: unknown) => void;
}

/** 診斷報告用的每台摘要 */
export interface DetectDiagnostics {
  config: DetectConfig;
  url: string | null;
  lastFrame: { at: number; state: DetectFrameState; score: number | null } | null;
  /** 最近 60 秒的最高分數 */
  peakScore: number | null;
  jpegAt: number | null;
  paused: boolean;
  onvif: OnvifSourceStatus | null;
  decode: CameraDecode | null;
}

/** 一台 detect worker 實際的解碼方式：device 是裝置識別字，null 是 CPU；fallback 是沒用到選定裝置的原因 */
export interface CameraDecode {
  cameraId: CameraId;
  device: string | null;
  /** 第一張畫面已經由這張卡解出（CPU 時恆為 false） */
  confirmed: boolean;
  fallback: HwFailure | null;
}

export interface Detection {
  /** 攝影機清單或設定變動後呼叫：更新控制檔（worker 立即套用）、建／停 ONVIF 訂閱 */
  sync(cameras: Camera[]): void;
  workerSpecs(): WorkerSpec[];
  latestJpeg(id: CameraId): { bytes: Uint8Array<ArrayBuffer>; at: number } | null;
  diagnostics(id: CameraId): DetectDiagnostics | null;
  /** 有 detect worker 的每台攝影機的解碼方式 */
  decodeStatus(): CameraDecode[];
  routes(): Route[];
  stop(): Promise<void>;
}

interface CamState {
  camera: Camera;
  detect: DetectConfig;
  url: string | null;
  paused: boolean;
  lastFrame: FrameResult | null;
  recentPeak: { at: number; score: number }[];
  jpeg: { bytes: Uint8Array<ArrayBuffer>; at: number } | null;
  jpegWaiters: Set<() => void>;
  samples: Set<(s: MotionSampleDto) => void>;
  controlText: string | null;
  /** 最近一次產生 worker 規格時的規劃 */
  decodePlan: DecodePlan | null;
  /** worker 這次執行回報的結果；worker 重啟時清掉 */
  decodeReport: DecodeReport | null;
}

/** 每秒 1 張時不帶參數，沒開物件辨識的攝影機的 worker 指令和以前一樣，不會因升級重啟 */
const jpegFpsArg = (fps: number) => (fps > 1 ? [String(Math.min(5, Math.round(fps)))] : []);

export function createDetection(opts: DetectionOptions): Detection {
  const now = opts.now ?? Date.now;
  const cams = new Map<CameraId, CamState>();
  const report = (scope: string, e: unknown) => opts.onError?.(scope, e);
  mkdirSync(opts.controlDir, { recursive: true });

  const onvif = createOnvifSources({
    fetch: opts.fetch,
    now,
    onSignal(id, s) {
      const c = cams.get(id);
      if (!c || !usesOnvif(c.detect)) return;
      const cooldown = c.detect.cooldownSec * 1000;
      if ("lost" in s) opts.events.signal(id, { type: "onvif-lost", at: s.at }, cooldown);
      else opts.events.signal(id, { type: "onvif", ...s }, cooldown);
    },
  });

  const controlPath = (id: CameraId) => join(opts.controlDir, `${id}.json`);

  function writeControl(c: CamState): void {
    const control: DetectControl = {
      diff: usesPixel(c.detect),
      threshold: c.detect.threshold,
      minArea: c.detect.minArea,
      masks: c.detect.masks,
      paused: c.paused,
    };
    const text = JSON.stringify(control);
    if (text === c.controlText) return;
    c.controlText = text;
    const path = controlPath(c.camera.id);
    const tmp = `${path}.tmp`;
    // 先寫暫存檔再改名，worker 不會讀到寫一半的檔案
    void writeFile(tmp, text)
      .then(() => rename(tmp, path))
      .catch((e) => report(`detect:${c.camera.id}`, e));
  }

  function onFrame(c: CamState, r: FrameResult): void {
    c.lastFrame = r;
    if (r.score !== null) {
      c.recentPeak.push({ at: r.at, score: r.score });
      while (c.recentPeak.length && r.at - c.recentPeak[0]!.at > 60_000) c.recentPeak.shift();
    }
    const id = c.camera.id;
    if (usesPixel(c.detect) && !c.paused) {
      opts.events.signal(id, { type: "pixel", at: r.at, score: r.score, motion: r.motion }, c.detect.cooldownSec * 1000);
    }
    if (c.samples.size === 0) return;
    const sample: MotionSampleDto = { at: r.at, score: r.score, motion: r.motion, state: c.paused && r.state !== "off" ? "paused" : r.state, eventActive: opts.events.activeFor(id) !== null };
    for (const fn of c.samples) fn(sample);
  }

  function onJpeg(c: CamState, bytes: Uint8Array<ArrayBuffer>): void {
    c.jpeg = { bytes, at: now() };
    opts.events.offerJpeg(c.camera.id, bytes);
    opts.onJpeg?.(c.camera.id, bytes, c.jpeg.at);
    for (const w of [...c.jpegWaiters]) w();
  }

  async function pump(id: CameraId, stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = new MsgReader();
    const dec = new TextDecoder();
    const started = cams.get(id);
    if (started) started.decodeReport = null;
    for await (const chunk of chunksOf(stdout)) {
      const c = cams.get(id);
      for (const msg of reader.push(chunk)) {
        if (!c) continue;
        if (msg.kind === MsgKind.frame) onFrame(c, JSON.parse(dec.decode(msg.payload)) as FrameResult);
        else if (msg.kind === MsgKind.jpeg) onJpeg(c, msg.payload);
        else if (msg.kind === MsgKind.decode) c.decodeReport = JSON.parse(dec.decode(msg.payload)) as DecodeReport;
      }
    }
  }

  function decodeOf(c: CamState): CameraDecode | null {
    const plan = c.decodePlan;
    if (!plan) return null;
    const r = c.decodeReport;
    const cameraId = c.camera.id;
    if (r?.mode === "cpu") return { cameraId, device: null, confirmed: false, fallback: { reason: r.reason, detail: r.detail } };
    return { cameraId, device: plan.hw?.deviceId ?? null, confirmed: plan.hw !== null && r?.mode === "hw", fallback: plan.note };
  }

  function sync(cameras: Camera[]): void {
    const seen = new Set<CameraId>();
    for (const camera of cameras) {
      if (!camera.config.enabled) continue;
      seen.add(camera.id);
      const detect = detectConfigOf(camera.config);
      let c = cams.get(camera.id);
      if (!c) {
        c = { camera, detect, url: null, paused: false, lastFrame: null, recentPeak: [], jpeg: null, jpegWaiters: new Set(), samples: new Set(), controlText: null, decodePlan: null, decodeReport: null };
        cams.set(camera.id, c);
      }
      const cooldown = detect.cooldownSec * 1000;
      // 拿掉了某個來源（含關閉偵測）：進行中的事件立刻收尾，不等一個不會再來的訊號
      const dropped = (usesPixel(c.detect) && !usesPixel(detect)) || (usesOnvif(c.detect) && !usesOnvif(detect));
      if (dropped) opts.events.signal(camera.id, { type: "stop", at: now() }, cooldown);
      c.camera = camera;
      c.detect = detect;
      c.url = opts.sourceUrl(camera);
      writeControl(c);
    }
    for (const [id, c] of cams) {
      if (seen.has(id)) continue;
      opts.events.signal(id, { type: "stop", at: now() }, 0);
      for (const fn of c.samples) fn({ at: now(), score: null, motion: false, state: "off", eventActive: false });
      cams.delete(id);
      void rm(controlPath(id), { force: true });
    }
    onvif.reconcile(cameras);
  }

  const timer = setInterval(() => {
    const at = now();
    for (const c of cams.values()) {
      const busy = opts.isBusy(c.camera.id);
      if (busy !== c.paused) {
        c.paused = busy;
        writeControl(c);
      }
      opts.events.signal(c.camera.id, { type: "tick", at }, c.detect.cooldownSec * 1000);
    }
  }, TICK_MS);

  function workerSpecs(): WorkerSpec[] {
    const specs: WorkerSpec[] = [];
    for (const c of cams.values()) {
      if (!c.url) {
        c.decodePlan = null;
        continue;
      }
      const id = c.camera.id;
      const plan = opts.decodePlan?.(c.camera) ?? { hw: null, note: null };
      // 規劃換了卡，上一次執行的回報就不算數；同一張卡則保留（規格沒變，worker 不會重啟）
      if (JSON.stringify(plan.hw) !== JSON.stringify(c.decodePlan?.hw)) c.decodeReport = null;
      c.decodePlan = plan;
      specs.push({
        id: `detect:${id}`,
        kind: "detect",
        cmd: [process.execPath, WORKER_SCRIPT, opts.env.ffmpegBin, c.url, controlPath(id), ...jpegFpsArg(opts.jpegFps?.(c.camera) ?? 1)],
        // CPU 時不帶，規格和加入硬體解碼前一樣，升級不會重啟
        ...(plan.hw ? { env: { [HW_DECODE_ENV]: JSON.stringify(plan.hw) } } : {}),
        stall: {
          graceMs: STALL_GRACE_MS,
          intervalMs: 5_000,
          healthy: () => {
            const last = cams.get(id)?.lastFrame?.at ?? 0;
            return now() - last < STALL_MS;
          },
        },
        readStdout: (stdout) => pump(id, stdout),
      });
    }
    return specs;
  }

  function freshJpeg(c: CamState) {
    return c.jpeg && now() - c.jpeg.at < SNAPSHOT_MAX_AGE_MS ? c.jpeg : null;
  }

  function nextJpeg(c: CamState, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        c.jpegWaiters.delete(done);
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(done, SNAPSHOT_WAIT_MS);
      signal.addEventListener("abort", done, { once: true });
      c.jpegWaiters.add(done);
    });
  }

  const camOf = (raw: string | undefined): CamState => {
    const c = cams.get((raw ?? "") as CameraId);
    if (!c) throw new HttpError(404, "找不到攝影機，或這台已停用");
    return c;
  };

  const snapshotRoute: Route = {
    method: "GET",
    path: "/api/cameras/:id/snapshot.jpg",
    access: "user",
    async handler(ctx) {
      const c = camOf(ctx.params.id);
      if (!freshJpeg(c)) await nextJpeg(c, ctx.req.signal);
      const jpeg = freshJpeg(c);
      if (!jpeg) return Response.json({ error: "目前取不到畫面" }, { status: 503 });
      return new Response(jpeg.bytes, {
        headers: { "content-type": "image/jpeg", "cache-control": "no-store", "x-snapshot-at": String(jpeg.at) },
      });
    },
  };

  const motionRoute: Route = {
    method: "GET",
    path: "/api/cameras/:id/motion",
    access: "admin",
    handler(ctx) {
      const c = camOf(ctx.params.id);
      const enc = new TextEncoder();
      let listener: ((s: MotionSampleDto) => void) | null = null;
      const ping = setInterval(() => q.enqueue(enc.encode(": ping\n\n")), PING_MS);
      const q = queuedStream(256 * 1024, () => {
        clearInterval(ping);
        if (listener) c.samples.delete(listener);
      });
      listener = (s) => {
        q.enqueue(enc.encode(`event: sample\ndata: ${JSON.stringify(s)}\n\n`));
        if (q.backlog() > 128 * 1024) q.abort();
      };
      c.samples.add(listener);
      q.enqueue(enc.encode("retry: 3000\n\n"));
      return new Response(q.stream, {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
      });
    },
  };

  return {
    sync,
    workerSpecs,
    latestJpeg: (id) => {
      const c = cams.get(id);
      return c ? freshJpeg(c) : null;
    },
    diagnostics(id) {
      const c = cams.get(id);
      if (!c) return null;
      const peaks = c.recentPeak.filter((p) => now() - p.at <= 60_000).map((p) => p.score);
      return {
        config: c.detect,
        url: c.url,
        lastFrame: c.lastFrame && { at: c.lastFrame.at, state: c.lastFrame.state, score: c.lastFrame.score },
        peakScore: peaks.length ? Math.max(...peaks) : null,
        jpegAt: c.jpeg?.at ?? null,
        paused: c.paused,
        onvif: onvif.status(id),
        decode: decodeOf(c),
      };
    },
    decodeStatus: () => [...cams.values()].flatMap((c) => decodeOf(c) ?? []),
    routes: () => [snapshotRoute, motionRoute],
    async stop() {
      clearInterval(timer);
      opts.events.stopAll(now());
      await onvif.stop();
    },
  };
}
