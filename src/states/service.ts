import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rm, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import backboneModel from "../../detector/backbone-model.json";
import {
  MAX_PENDING_STATE_IMAGES,
  MIN_STATE_IMAGES_PER_CLASS,
  type StateChangeDto,
  type StateImageDto,
  type StateJobDto,
  type StateJobKind,
  type StateModelDto,
  type StateProblemCode,
  type StateReadingDto,
  type StateSensorConfig,
  type StateSensorDto,
  type StreamMessage,
} from "../api-types.ts";
import { chunksOf } from "../detect/protocol.ts";
import { encodeJson } from "../workers/framing.ts";
import { createSocketLink } from "../workers/socket-link.ts";
import type { Env } from "../env.ts";
import { HttpError } from "../http/errors.ts";
import { msg, type Msg, zh } from "../messages/index.ts";
import { asObject, readJson } from "../http/validate.ts";
import type { Camera, CameraId, Route, WorkerSpec } from "../types.ts";
import { samplePoints } from "./collect.ts";
import { parseClassName, parseFrigateConfig, parseSensorConfig } from "./config.ts";
import { step, UNKNOWN, type Consensus } from "./consensus.ts";
import { encodeClassify, parseWorkerMsg, type ClassifyRequest, type Reading, type WorkerJob } from "./protocol.ts";
import * as store from "./store.ts";
import type { ImageRow, SensorId, SensorRow } from "./store.ts";

const WORKER_SCRIPT = join(import.meta.dir, "../../detector/classify.py");
const BACKBONE_PATH = join(import.meta.dir, "../../detector/models", backboneModel.file);
/** 驗證中（有候選狀態）時多久補跑一次；detect worker 的快照多半每秒一張，實際上是每張新快照都跑 */
const VERIFY_MS = 500;
const MOTION_MS = 1_000;
/** 快照比這更舊就當攝影機沒畫面 */
const FRAME_MAX_AGE_MS = 30_000;
/** 沒畫面這麼久就把狀態改回未知 */
const UNKNOWN_AFTER_MS = 60_000;
/** 鏡頭移動或亮度突變後這段時間內不辨識 */
const BLOCKED_HOLD_MS = 3_000;
/** 信心低或驗證中的畫面，每個感應器最多這麼久存一張到待標記 */
const SAVE_EVERY_MS = 60_000;
const LOW_CONFIDENCE = 0.95;
const STALL_MS = 10_000;
const LOAD_LIMIT_MS = 120_000;
const PROGRESS_PUSH_MS = 500;
const COLLECT_POINTS = 100;
const COLLECT_COUNT = 24;
/** Bun.serve 預設的請求本體上限是 128 MB */
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
const RECENT_READINGS = 10;
const TICK_MS = 5_000;

type Phase =
  | { tag: "off" }
  | { tag: "starting" }
  | { tag: "loading"; since: number }
  | { tag: "ready"; backbone: string; loadMs: number }
  | { tag: "error"; message: string; msg: Msg; detail: string | null };

interface Runtime {
  row: SensorRow;
  model: StateModelDto | null;
  consensus: Consensus;
  since: number | null;
  score: number | null;
  lastReading: StateReadingDto | null;
  recent: StateReadingDto[];
  lastRunAt: number;
  lastCheckAt: number;
  lastSavedAt: number;
  /** 這次開始辨識後還沒有任何讀數：第一張存進待標記 */
  fresh: boolean;
  blockedAt: number;
  job: StateJobDto | null;
  jobId: number | null;
  publishedAt: number;
  /** 上次推送時的 problem，變了才推 */
  problemKey: string;
}

type Queued = { cmd: WorkerJob; sensorId: SensorId };

export interface StateClassificationOptions {
  db: Database;
  env: Pick<Env, "detectorPython" | "dataDir" | "ffmpegBin">;
  cameras: () => Camera[];
  /** 鏡頭移動中，或這張畫面亮度突變（例如切換夜視） */
  blocked: (id: CameraId) => boolean;
  segments: (id: CameraId) => { path: string; startMs: number; endMs: number | null }[];
  publish: (msg: StreamMessage) => void;
  /** 需要的 worker 變了（例如第一個感應器建立），請主程序重新對帳 */
  onWorkersChanged: () => void;
  socketPath?: string;
  now?: () => number;
  onError?: (scope: string, e: unknown) => void;
}

export interface StateDiagnostics {
  worker: { phase: Phase["tag"]; backbone: string | null; loadMs: number | null; error: string | null; detail: string | null };
  sensors: {
    id: string;
    cameraId: CameraId;
    config: StateSensorConfig;
    state: string | null;
    since: number | null;
    candidate: Consensus["candidate"];
    problem: StateSensorDto["problem"];
    model: StateModelDto | null;
    images: StateSensorDto["images"];
    job: StateJobDto | null;
    recent: StateReadingDto[];
  }[];
}

export interface StateClassification {
  workerSpecs(): WorkerSpec[];
  /** detect worker 每送來一張快照就交給它 */
  offerJpeg(cameraId: CameraId, jpeg: Uint8Array, at: number): void;
  /** 攝影機清單變動：刪掉已不存在的攝影機的感應器 */
  sync(cameras: Camera[]): void;
  list(): StateSensorDto[];
  /** 刪掉比 cutoff 舊的切換紀錄（保留期限和事件相同） */
  prune(cutoff: number): Promise<number>;
  diagnostics(): StateDiagnostics;
  routes(): Route[];
  stop(): Promise<void>;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const randomId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const CONTENT_TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

export function createStateClassification(opts: StateClassificationOptions): StateClassification {
  const { db } = opts;
  const now = opts.now ?? Date.now;
  const report = (e: unknown) => opts.onError?.("states", e);
  const socketPath = opts.socketPath ?? `/tmp/cookienvr-${process.pid}-classify.sock`;
  const root = join(opts.env.dataDir, "states");
  const sensorDir = (id: string) => join(root, id);
  const imagesDir = (id: string) => join(sensorDir(id), "images");
  const modelPath = (id: string) => join(sensorDir(id), "model.json");
  const thumbPath = (id: string, changeId: number) => join(sensorDir(id), "changes", `${changeId}.jpg`);

  let phase: Phase = { tag: "off" };
  const link = createSocketLink({ path: socketPath, now, onMessage, onDisconnect: disconnected, onError: report });
  let nextId = 1;
  let inFlight: { id: number; sensorId: SensorId; sentAt: number; mode: ClassifyRequest["mode"] } | null = null;
  const pending = new Map<SensorId, { req: Omit<ClassifyRequest, "id">; jpeg: Uint8Array }>();
  const jobQueue: Queued[] = [];
  const jobOwners = new Map<number, SensorId>();
  /** 已經送給 worker 的工作；worker 斷線時只有這些算中斷，還在 jobQueue 的等重連後再送 */
  const sentJobs = new Set<number>();
  const lastJpegAt = new Map<CameraId, number>();
  const sensors = new Map<SensorId, Runtime>();

  for (const row of store.listSensors(db)) sensors.set(row.id, runtime(row));

  function runtime(row: SensorRow): Runtime {
    return {
      row,
      model: readModel(row.id),
      consensus: UNKNOWN,
      since: null,
      score: null,
      lastReading: null,
      recent: [],
      lastRunAt: 0,
      lastCheckAt: 0,
      lastSavedAt: 0,
      fresh: true,
      blockedAt: 0,
      job: null,
      jobId: null,
      publishedAt: 0,
      problemKey: "",
    };
  }

  function readModel(id: string): StateModelDto | null {
    try {
      const m = JSON.parse(readFileSync(modelPath(id), "utf8")) as Omit<StateModelDto, "backbone"> & { backbone?: { id?: string; name?: string } };
      if (m.backbone?.id !== backboneModel.id) return null;
      return { trainedAt: m.trainedAt, classes: m.classes, counts: m.counts, validation: m.validation, trainMs: m.trainMs, backbone: m.backbone.name ?? backboneModel.name };
    } catch {
      return null;
    }
  }

  // ─── worker 連線 ───

  const ready = () => link.connected() && phase.tag === "ready";

  function pump(): void {
    if (!ready()) return;
    while (jobQueue.length) {
      const q = jobQueue.shift()!;
      if (!sensors.has(q.sensorId)) continue;
      sentJobs.add(q.cmd.job);
      link.write(encodeJson(q.cmd));
    }
    if (inFlight) return;
    const next = pending.entries().next();
    if (next.done) return;
    const [sensorId, { req, jpeg }] = next.value;
    pending.delete(sensorId);
    const id = nextId++;
    inFlight = { id, sensorId, sentAt: now(), mode: req.mode };
    link.write(encodeClassify({ ...req, id }, jpeg));
  }

  function onMessage(kind: number, payload: Uint8Array): void {
    const m = parseWorkerMsg(kind, payload);
    if (!m) return;
    switch (m.type) {
      case "loading":
        phase = { tag: "loading", since: now() };
        break;
      case "ready":
        phase = { tag: "ready", backbone: m.backbone, loadMs: m.loadMs };
        refreshProblems();
        pump();
        break;
      case "error":
        phase = { tag: "error", message: m.error, msg: m.errorMsg, detail: m.detail };
        failJobs(msg("states.workerStartFailed"));
        refreshProblems();
        break;
      case "heartbeat":
        break;
      case "reading":
        onReading(m.reading);
        break;
      case "job-progress":
        onJobProgress(m.job, m.progress);
        break;
      case "job-result":
        void onJobResult(m.job, m.ok ? { ok: true, result: m.result } : { ok: false, error: m.errorMsg }).catch(report);
        break;
    }
  }

  function disconnected(): void {
    inFlight = null;
    pending.clear();
    phase = needsWorker() ? { tag: "starting" } : { tag: "off" };
    for (const rt of sensors.values()) {
      if (rt.jobId !== null && sentJobs.has(rt.jobId)) finishJob(rt, { ok: false, error: msg("states.workerRestarted") });
    }
    sentJobs.clear();
  }

  const jobActive = (rt: Runtime) => rt.job?.state === "queued" || rt.job?.state === "running";
  const needsWorker = () => [...sensors.values()].some((rt) => (rt.row.config.enabled && rt.model) || jobActive(rt));

  function healthy(): boolean {
    const t = now();
    if (t - link.lastSeenAt() > STALL_MS) return false;
    if (inFlight && t - inFlight.sentAt > STALL_MS) return false;
    return !(phase.tag === "loading" && t - phase.since > LOAD_LIMIT_MS);
  }

  function workerSpecs(): WorkerSpec[] {
    if (!needsWorker()) {
      if (phase.tag !== "off" && !link.connected()) phase = { tag: "off" };
      return [];
    }
    link.listen();
    if (phase.tag === "off") phase = { tag: "starting" };
    return [
      {
        id: "classifier",
        kind: "classifier",
        cmd: [opts.env.detectorPython, WORKER_SCRIPT, "--socket", socketPath, "--backbone", BACKBONE_PATH],
        env: { PYTHONUNBUFFERED: "1" },
        stall: { intervalMs: 2_000, graceMs: 20_000, healthy },
      },
    ];
  }

  // ─── 辨識 ───

  function problemOf(rt: Runtime): StateSensorDto["problem"] {
    const p = (code: StateProblemCode, m: Msg) => ({ code, message: zh(m), msg: m });
    const { config } = rt.row;
    if (!config.enabled) return p("disabled", msg("states.problemDisabled"));
    if (!rt.model) return p("untrained", msg("states.problemUntrained"));
    if (!sameSet(rt.model.classes, config.classes)) return p("stale-model", msg("states.problemStaleModel"));
    if (phase.tag === "error") {
      return p("worker", phase.msg.code === "states.backboneLoadFailed" ? msg("states.problemBackboneFailed") : msg("states.problemWorkerFailed", { text: phase.message }));
    }
    if (phase.tag !== "ready") return p("worker", msg("states.problemWorkerStarting"));
    const camera = opts.cameras().find((c) => c.id === rt.row.cameraId);
    const seen = lastJpegAt.get(rt.row.cameraId) ?? 0;
    if (!camera?.config.enabled || now() - seen > FRAME_MAX_AGE_MS) return p("camera-off", msg("states.problemCameraOff"));
    if (now() - rt.blockedAt < BLOCKED_HOLD_MS) return p("paused", msg("states.problemPaused"));
    return null;
  }

  function imagesOf(rt: Runtime): StateSensorDto["images"] {
    const counts = store.imageCounts(db, rt.row.id);
    return { pending: counts.get(null) ?? 0, labeled: rt.row.config.classes.map((label) => ({ label, count: counts.get(label) ?? 0 })) };
  }

  function dto(rt: Runtime): StateSensorDto {
    const images = imagesOf(rt);
    return {
      id: rt.row.id,
      cameraId: rt.row.cameraId,
      config: rt.row.config,
      state: rt.consensus.current,
      since: rt.consensus.current === null ? null : rt.since,
      score: rt.consensus.current === null ? null : rt.score,
      candidate: rt.consensus.candidate,
      lastReading: rt.lastReading,
      model: rt.model,
      images,
      trainable: images.labeled.every((c) => c.count >= MIN_STATE_IMAGES_PER_CLASS),
      job: rt.job,
      problem: problemOf(rt),
      createdAt: rt.row.createdAt,
    };
  }

  function publishSensor(rt: Runtime): void {
    rt.publishedAt = now();
    const d = dto(rt);
    rt.problemKey = d.problem?.code ?? "";
    opts.publish({ type: "state-sensor", data: d });
  }

  /** problem 變了才推；會讓狀態失效的問題把狀態改回未知 */
  function refreshProblems(): void {
    for (const rt of sensors.values()) {
      const p = problemOf(rt);
      const stale = p && p.code !== "paused" && (p.code !== "camera-off" || now() - (lastJpegAt.get(rt.row.cameraId) ?? 0) > UNKNOWN_AFTER_MS);
      let changed = (p?.code ?? "") !== rt.problemKey;
      if (stale && (rt.consensus.current !== null || rt.consensus.candidate)) {
        rt.consensus = UNKNOWN;
        rt.fresh = true;
        changed = true;
      }
      if (changed) publishSensor(rt);
    }
  }

  function offerJpeg(cameraId: CameraId, jpeg: Uint8Array, at: number): void {
    const wasStale = now() - (lastJpegAt.get(cameraId) ?? 0) > FRAME_MAX_AGE_MS;
    lastJpegAt.set(cameraId, at);
    const blocked = opts.blocked(cameraId);
    for (const rt of sensors.values()) {
      if (rt.row.cameraId !== cameraId) continue;
      if (blocked) rt.blockedAt = at;
      const problem = problemOf(rt);
      if ((problem?.code ?? "") !== rt.problemKey || (wasStale && !problem)) publishSensor(rt);
      if (problem || !rt.model) continue;
      const { config } = rt.row;
      let mode: ClassifyRequest["mode"] | null = null;
      if (rt.consensus.candidate && at - rt.lastRunAt >= VERIFY_MS) mode = "force";
      else if (rt.consensus.current === null && at - rt.lastRunAt >= VERIFY_MS && rt.fresh) mode = "force";
      else if (config.intervalSec > 0 && at - rt.lastRunAt >= config.intervalSec * 1000) mode = "force";
      else if (config.onMotion && at - rt.lastCheckAt >= MOTION_MS) mode = "changed";
      if (!mode) continue;
      rt.lastCheckAt = at;
      pending.set(rt.row.id, { req: { type: "classify", sensor: rt.row.id, model: modelPath(rt.row.id), crop: config.crop, mode }, jpeg });
    }
    pump();
  }

  function onReading(r: Reading): void {
    const flight = inFlight;
    if (!flight || flight.id !== r.id) return;
    inFlight = null;
    const rt = sensors.get(flight.sensorId);
    if (rt && r.kind === "error") report(new Error(`${rt.row.config.name}: ${r.error}`));
    if (rt && r.kind === "ok" && rt.row.config.classes.includes(r.label)) applyReading(rt, r);
    pump();
  }

  function applyReading(rt: Runtime, r: Extract<Reading, { kind: "ok" }>): void {
    const at = now();
    rt.lastRunAt = at;
    const reading: StateReadingDto = { at, label: r.label, score: r.score };
    rt.lastReading = reading;
    rt.recent.push(reading);
    if (rt.recent.length > RECENT_READINGS) rt.recent.shift();
    const first = rt.fresh;
    rt.fresh = false;
    const before = rt.consensus;
    const s = step(before, reading, rt.row.config.threshold);
    rt.consensus = s.next;
    if (s.kind === "switched") {
      rt.score = r.score;
      recordSwitch(rt, r, at);
    }
    const save = first || s.kind === "switched" || ((s.kind === "verifying" || r.score < LOW_CONFIDENCE) && at - rt.lastSavedAt >= SAVE_EVERY_MS);
    if (save) saveLive(rt, r, at);
    const candidateChanged = JSON.stringify(before.candidate) !== JSON.stringify(s.next.candidate);
    if (s.kind === "switched" || candidateChanged) publishSensor(rt);
  }

  /** 切換：寫紀錄與縮圖並推送。重新確認的狀態和最後一筆紀錄相同（重啟、攝影機斷線又回來）就只沿用時間，不重複記錄 */
  function recordSwitch(rt: Runtime, r: Extract<Reading, { kind: "ok" }>, at: number): void {
    const last = store.lastChange(db, rt.row.id);
    if (last && last.to === r.label) {
      rt.since = last.at;
      return;
    }
    rt.since = at;
    const change = store.insertChange(db, { sensorId: rt.row.id, cameraId: rt.row.cameraId, at, from: last?.to ?? null, to: r.label, score: r.score, hasThumb: false });
    const path = thumbPath(rt.row.id, change.id);
    mkdirSync(join(sensorDir(rt.row.id), "changes"), { recursive: true });
    void writeFile(path, r.crop)
      .then(() => store.setChangeThumb(db, change.id))
      .catch(report);
    opts.publish({ type: "state-change", data: changeDto({ ...change, hasThumb: true }) });
  }

  function saveLive(rt: Runtime, r: Extract<Reading, { kind: "ok" }>, at: number): void {
    rt.lastSavedAt = at;
    const id = randomId();
    const file = `${id}.jpg`;
    const sensorId = rt.row.id;
    mkdirSync(imagesDir(sensorId), { recursive: true });
    void writeFile(join(imagesDir(sensorId), file), r.crop)
      .then(() => {
        if (!sensors.has(sensorId)) return;
        store.insertImages(db, [{ id, sensorId, file, label: null, source: "live", createdAt: at, guess: { label: r.label, score: r.score } }]);
        removeImages(sensorId, store.overflowLiveImages(db, sensorId, MAX_PENDING_STATE_IMAGES));
      })
      .catch(report);
  }

  function removeImages(sensorId: SensorId, ids: string[]): number {
    if (!ids.length) return 0;
    const files = store.deleteImages(db, sensorId, ids);
    for (const f of files) void unlink(join(imagesDir(sensorId), f)).catch(() => {});
    return files.length;
  }

  const changeDto = (c: store.ChangeRow): StateChangeDto => ({
    id: c.id,
    sensorId: c.sensorId,
    cameraId: c.cameraId,
    at: c.at,
    from: c.from,
    to: c.to,
    score: c.score,
    thumbUrl: c.hasThumb ? `/api/state-changes/${c.id}/thumb.jpg` : null,
  });

  // ─── 背景工作 ───

  function startJob(rt: Runtime, kind: StateJobKind, build: (job: number) => WorkerJob): void {
    if (jobActive(rt)) throw new HttpError(409, msg("states.jobBusy"));
    const job = nextId++;
    rt.job = { kind, state: "queued", startedAt: now() };
    rt.jobId = job;
    jobOwners.set(job, rt.row.id);
    jobQueue.push({ cmd: build(job), sensorId: rt.row.id });
    publishSensor(rt);
    if (phase.tag === "off") opts.onWorkersChanged();
    pump();
  }

  function finishJob(rt: Runtime, result: { ok: true; msg: Msg } | { ok: false; error: Msg }): void {
    if (!rt.job) return;
    const base = { kind: rt.job.kind, startedAt: rt.job.startedAt, finishedAt: now() };
    rt.job = result.ok
      ? { ...base, state: "done", message: zh(result.msg), msg: result.msg }
      : { ...base, state: "failed", error: zh(result.error), errorMsg: result.error };
    if (rt.jobId !== null) {
      jobOwners.delete(rt.jobId);
      sentJobs.delete(rt.jobId);
    }
    rt.jobId = null;
    publishSensor(rt);
    opts.onWorkersChanged();
  }

  function failJobs(error: Msg): void {
    for (const rt of sensors.values()) if (jobActive(rt)) finishJob(rt, { ok: false, error });
    jobQueue.length = 0;
  }

  function onJobProgress(job: number, progress: number): void {
    const rt = sensors.get(jobOwners.get(job) as SensorId);
    if (!rt?.job || rt.jobId !== job || !jobActive(rt)) return;
    rt.job = { kind: rt.job.kind, state: "running", startedAt: rt.job.startedAt, progress };
    if (now() - rt.publishedAt >= PROGRESS_PUSH_MS) publishSensor(rt);
  }

  async function onJobResult(job: number, r: { ok: true; result: Record<string, unknown> } | { ok: false; error: Msg }): Promise<void> {
    const sensorId = jobOwners.get(job);
    const rt = sensorId ? sensors.get(sensorId) : undefined;
    if (!rt || rt.jobId !== job || !rt.job) {
      if (sensorId && !sensors.has(sensorId)) await rm(sensorDir(sensorId), { recursive: true, force: true });
      return;
    }
    if (!r.ok) return finishJob(rt, { ok: false, error: r.error });
    try {
      finishJob(rt, { ok: true, msg: applyJobResult(rt, rt.job.kind, r.result) });
    } catch (e) {
      finishJob(rt, { ok: false, error: e instanceof HttpError ? e.msg : msg("raw", { text: e instanceof Error ? e.message : String(e) }) });
    }
  }

  function applyJobResult(rt: Runtime, kind: StateJobKind, result: Record<string, unknown>): Msg {
    const sensorId = rt.row.id;
    const at = now();
    if (kind === "train") {
      rt.model = readModel(sensorId);
      if (!rt.model) throw new HttpError(500, msg("states.modelMissing"));
      rt.consensus = UNKNOWN;
      rt.fresh = true;
      const v = rt.model.validation;
      return v ? msg("states.trainDone", { accuracy: Math.round(v.accuracy * 1000) / 10 }) : msg("states.trainDoneNoValidation");
    }
    if (kind === "collect") {
      const images = (result.images as { file: string; at: number | null }[] | undefined) ?? [];
      store.insertImages(
        db,
        images.map((im, i) => ({ id: im.file.replace(/\.[^.]+$/, ""), sensorId, file: im.file, label: null, source: "recording", createdAt: at - i, guess: null })),
      );
      if (!images.length) throw new HttpError(500, msg("states.collectNoFrames"));
      return msg("states.collectDone", { count: images.length });
    }
    const labeled = (result.labeled as { file: string; label: string }[] | undefined) ?? [];
    const pendingImages = (result.pending as { file: string; guess: { label: string; score: number } | null }[] | undefined) ?? [];
    const skipped = Number(result.skipped ?? 0);
    const known = new Set(rt.row.config.classes);
    const added = [...new Set(labeled.map((l) => l.label))].filter((l) => !known.has(l));
    if (added.length) {
      const classes = [...rt.row.config.classes, ...added].slice(0, 10);
      updateConfig(rt, { ...rt.row.config, classes });
    }
    const rows: ImageRow[] = [
      ...labeled.map((l, i) => ({ id: l.file.replace(/\.[^.]+$/, ""), sensorId, file: l.file, label: rt.row.config.classes.includes(l.label) ? l.label : null, source: "import" as const, createdAt: at - i, guess: null })),
      ...pendingImages.map((p, i) => ({ id: p.file.replace(/\.[^.]+$/, ""), sensorId, file: p.file, label: null, source: "import" as const, createdAt: at - labeled.length - i, guess: p.guess })),
    ];
    store.insertImages(db, rows);
    if (!rows.length) throw new HttpError(500, msg("states.importNoImages"));
    return msg("states.importDone", { labeled: labeled.length, pending: pendingImages.length, added, skipped });
  }

  // ─── 設定與圖片 ───

  function updateConfig(rt: Runtime, config: StateSensorConfig): void {
    const before = rt.row.config;
    for (const c of before.classes) if (!config.classes.includes(c)) store.relabel(db, rt.row.id, c, null);
    if (!sameSet(before.classes, config.classes) || JSON.stringify(before.crop) !== JSON.stringify(config.crop)) {
      rt.consensus = UNKNOWN;
      rt.fresh = true;
    }
    rt.row = { ...rt.row, config };
    store.updateSensorConfig(db, rt.row.id, config, now());
  }

  function renameClass(rt: Runtime, from: string, to: string): void {
    const { config } = rt.row;
    if (!config.classes.includes(from)) throw new HttpError(400, msg("states.classNotFound", { name: from }));
    if (from === to) return;
    if (config.classes.includes(to)) throw new HttpError(400, msg("states.classExists", { name: to }));
    const swap = (c: string) => (c === from ? to : c);
    rt.row = { ...rt.row, config: { ...config, classes: config.classes.map(swap) } };
    db.transaction(() => {
      store.updateSensorConfig(db, rt.row.id, rt.row.config, now());
      store.relabel(db, rt.row.id, from, to);
      store.renameInChanges(db, rt.row.id, from, to);
    })();
    if (rt.model?.classes.includes(from)) {
      const path = modelPath(rt.row.id);
      const m = JSON.parse(readFileSync(path, "utf8")) as { classes: string[] };
      m.classes = m.classes.map(swap);
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(m));
      renameSync(tmp, path);
      rt.model = readModel(rt.row.id);
    }
    const c = rt.consensus;
    rt.consensus = { current: c.current === null ? null : swap(c.current), candidate: c.candidate ? { ...c.candidate, label: swap(c.candidate.label) } : null };
    if (rt.lastReading) rt.lastReading = { ...rt.lastReading, label: swap(rt.lastReading.label) };
  }

  async function removeSensor(id: SensorId): Promise<void> {
    sensors.delete(id);
    pending.delete(id);
    store.deleteSensor(db, id);
    await rm(sensorDir(id), { recursive: true, force: true });
    opts.publish({ type: "state-sensor-removed", data: { id } });
    opts.onWorkersChanged();
  }

  const imageDto = (rt: Runtime, im: ImageRow): StateImageDto => ({
    id: im.id,
    label: im.label,
    source: im.source,
    createdAt: im.createdAt,
    guess: im.guess,
    url: `/api/states/${rt.row.id}/images/${im.id}`,
  });

  function sensorOf(raw: string | undefined): Runtime {
    const rt = sensors.get((raw ?? "") as SensorId);
    if (!rt) throw new HttpError(404, msg("states.sensorNotFound"));
    return rt;
  }

  function idList(v: unknown): string[] {
    if (!Array.isArray(v) || v.length === 0 || v.length > 1000 || !v.every((x) => typeof x === "string" && /^[0-9a-f]{1,32}$/.test(x))) {
      throw new HttpError(400, msg("states.idsInvalid"));
    }
    return v as string[];
  }

  function startCollect(rt: Runtime): void {
    const points = samplePoints(opts.segments(rt.row.cameraId), COLLECT_POINTS);
    if (!points.length) {
      const noRec = msg("states.collectNoRecordings");
      rt.job = { kind: "collect", state: "failed", startedAt: now(), finishedAt: now(), error: zh(noRec), errorMsg: noRec };
      publishSensor(rt);
      return;
    }
    const outDir = imagesDir(rt.row.id);
    startJob(rt, "collect", (job) => ({ type: "collect", job, ffmpeg: opts.env.ffmpegBin, points, crop: rt.row.config.crop, outDir, count: COLLECT_COUNT }));
  }

  async function saveUpload(req: Request, path: string): Promise<void> {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_IMPORT_BYTES) throw new HttpError(413, msg("states.fileTooLarge"));
    if (!req.body) throw new HttpError(400, msg("states.noFile"));
    const sink = Bun.file(path).writer();
    let size = 0;
    try {
      for await (const chunk of chunksOf(req.body)) {
        size += chunk.length;
        if (size > MAX_IMPORT_BYTES) throw new HttpError(413, msg("states.fileTooLarge"));
        sink.write(chunk);
      }
    } finally {
      await sink.end();
    }
    if (size < 22) throw new HttpError(400, msg("states.notZip"));
    const head = new Uint8Array(await Bun.file(path).slice(0, 4).arrayBuffer());
    if (head[0] !== 0x50 || head[1] !== 0x4b) throw new HttpError(400, msg("states.notZip"));
  }

  function json(data: unknown, status = 200): Response {
    return Response.json(data, { status });
  }

  function routes(): Route[] {
    return [
      {
        method: "GET",
        path: "/api/states",
        access: "user",
        handler: ({ url }) => {
          const cameraId = url.searchParams.get("cameraId");
          return json(list().filter((s) => !cameraId || s.cameraId === cameraId));
        },
      },
      {
        method: "POST",
        path: "/api/states",
        access: "admin",
        async handler({ req }) {
          const body = asObject(await readJson(req));
          const cameraId = body.cameraId as CameraId;
          if (typeof cameraId !== "string" || !opts.cameras().some((c) => c.id === cameraId)) throw new HttpError(400, msg("states.cameraNotFound"));
          const config = parseSensorConfig(body.config);
          const row: SensorRow = { id: store.newSensorId(), cameraId, config, createdAt: now() };
          store.insertSensor(db, row);
          const rt = runtime(row);
          sensors.set(row.id, rt);
          if (body.collect !== false) startCollect(rt);
          else publishSensor(rt);
          return json(dto(rt), 201);
        },
      },
      {
        method: "POST",
        path: "/api/states/frigate-config",
        access: "admin",
        async handler({ req }) {
          const body = asObject(await readJson(req));
          if (typeof body.yaml !== "string" || body.yaml.length > 200_000) throw new HttpError(400, msg("states.yamlNotString"));
          return json(parseFrigateConfig(body.yaml));
        },
      },
      { method: "GET", path: "/api/states/:id", access: "user", handler: ({ params }) => json(dto(sensorOf(params.id))) },
      {
        method: "PUT",
        path: "/api/states/:id",
        access: "admin",
        async handler({ req, params }) {
          const rt = sensorOf(params.id);
          const body = asObject(await readJson(req));
          updateConfig(rt, parseSensorConfig(body.config, rt.row.config));
          publishSensor(rt);
          opts.onWorkersChanged();
          return json(dto(rt));
        },
      },
      {
        method: "DELETE",
        path: "/api/states/:id",
        access: "admin",
        async handler({ params }) {
          await removeSensor(sensorOf(params.id).row.id);
          return new Response(null, { status: 204 });
        },
      },
      {
        method: "POST",
        path: "/api/states/:id/classes/rename",
        access: "admin",
        async handler({ req, params }) {
          const rt = sensorOf(params.id);
          const body = asObject(await readJson(req));
          renameClass(rt, parseClassName(body.from), parseClassName(body.to, true));
          publishSensor(rt);
          return json(dto(rt));
        },
      },
      {
        method: "POST",
        path: "/api/states/:id/collect",
        access: "admin",
        handler({ params }) {
          const rt = sensorOf(params.id);
          if (jobActive(rt)) throw new HttpError(409, msg("states.jobBusy"));
          startCollect(rt);
          return json(dto(rt), 202);
        },
      },
      {
        method: "POST",
        path: "/api/states/:id/train",
        access: "admin",
        handler({ params }) {
          const rt = sensorOf(params.id);
          const d = dto(rt);
          if (!d.trainable) throw new HttpError(400, msg("states.notTrainable", { min: MIN_STATE_IMAGES_PER_CLASS }));
          const { classes } = rt.row.config;
          const items = store
            .listImages(db, rt.row.id)
            .filter((im) => im.label !== null && classes.includes(im.label))
            .map((im) => ({ path: join(imagesDir(rt.row.id), im.file), label: im.label! }));
          const out = modelPath(rt.row.id);
          startJob(rt, "train", (job) => ({ type: "train", job, items, classes, out }));
          return json(dto(rt), 202);
        },
      },
      {
        method: "POST",
        path: "/api/states/:id/import",
        access: "admin",
        accepts: ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
        async handler({ req, params }) {
          const rt = sensorOf(params.id);
          if (jobActive(rt)) throw new HttpError(409, msg("states.jobBusy"));
          mkdirSync(imagesDir(rt.row.id), { recursive: true });
          const zip = join(sensorDir(rt.row.id), `import-${randomId()}.zip`);
          try {
            await saveUpload(req, zip);
          } catch (e) {
            await rm(zip, { force: true });
            throw e;
          }
          startJob(rt, "import", (job) => ({ type: "import", job, zip, outDir: imagesDir(rt.row.id) }));
          // 匯入完成或失敗後刪掉上傳的 zip
          const jobId = rt.jobId;
          const cleanup = setInterval(() => {
            if (rt.jobId === jobId && jobActive(rt) && sensors.has(rt.row.id)) return;
            clearInterval(cleanup);
            void rm(zip, { force: true });
          }, 1_000);
          return json(dto(rt), 202);
        },
      },
      {
        method: "GET",
        path: "/api/states/:id/images",
        access: "user",
        handler({ params, url }) {
          const rt = sensorOf(params.id);
          const label = url.searchParams.get("label") ?? "all";
          const images = store.listImages(db, rt.row.id).filter((im) => label === "all" || (label === "pending" ? im.label === null : im.label === label));
          return json({ images: images.map((im) => imageDto(rt, im)) });
        },
      },
      {
        method: "GET",
        path: "/api/states/:id/images/:imageId",
        access: "user",
        handler({ params }) {
          const rt = sensorOf(params.id);
          const im = store.getImage(db, rt.row.id, params.imageId ?? "");
          if (!im) throw new HttpError(404, msg("states.imageNotFound"));
          const file = Bun.file(join(imagesDir(rt.row.id), im.file));
          return new Response(file, { headers: { "Content-Type": CONTENT_TYPES[extname(im.file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "private, max-age=86400, immutable" } });
        },
      },
      {
        method: "POST",
        path: "/api/states/:id/images/label",
        access: "admin",
        async handler({ req, params }) {
          const rt = sensorOf(params.id);
          const body = asObject(await readJson(req));
          const ids = idList(body.ids);
          const label = body.label === null ? null : parseClassName(body.label);
          if (label !== null && !rt.row.config.classes.includes(label)) throw new HttpError(400, msg("states.classNotFound", { name: label }));
          store.setImageLabels(db, rt.row.id, ids, label);
          publishSensor(rt);
          return json(dto(rt));
        },
      },
      {
        method: "POST",
        path: "/api/states/:id/images/delete",
        access: "admin",
        async handler({ req, params }) {
          const rt = sensorOf(params.id);
          const body = asObject(await readJson(req));
          removeImages(rt.row.id, idList(body.ids));
          publishSensor(rt);
          return json(dto(rt));
        },
      },
      {
        method: "GET",
        path: "/api/state-changes",
        access: "user",
        handler({ url }) {
          const q = url.searchParams;
          const before = q.get("before");
          const limit = Math.min(500, Math.max(1, Number(q.get("limit") ?? 50) || 50));
          const rows = store.queryChanges(db, {
            sensorId: q.get("sensorId"),
            cameraId: q.get("cameraId"),
            before: before !== null && /^\d+$/.test(before) ? Number(before) : null,
            limit,
          });
          return json(rows.map(changeDto));
        },
      },
      {
        method: "GET",
        path: "/api/state-changes/:id/thumb.jpg",
        access: "user",
        async handler({ params }) {
          const c = /^\d+$/.test(params.id ?? "") ? store.getChange(db, Number(params.id)) : null;
          const file = c?.hasThumb ? Bun.file(thumbPath(c.sensorId, c.id)) : null;
          if (!file || !(await file.exists())) throw new HttpError(404, msg("states.noThumb"));
          return new Response(file, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400, immutable" } });
        },
      },
    ];
  }

  function list(): StateSensorDto[] {
    return [...sensors.values()].map(dto);
  }

  function sync(cameras: Camera[]): void {
    const ids = new Set(cameras.map((c) => c.id));
    for (const rt of [...sensors.values()]) if (!ids.has(rt.row.cameraId)) void removeSensor(rt.row.id).catch(report);
  }

  async function prune(cutoff: number): Promise<number> {
    const gone = store.deleteChangesBefore(db, cutoff);
    await Promise.all(gone.map((g) => rm(thumbPath(g.sensorId, g.id), { force: true })));
    return gone.length;
  }

  function diagnostics(): StateDiagnostics {
    return {
      worker: {
        phase: phase.tag,
        backbone: phase.tag === "ready" ? phase.backbone : null,
        loadMs: phase.tag === "ready" ? phase.loadMs : null,
        error: phase.tag === "error" ? phase.message : null,
        detail: phase.tag === "error" ? phase.detail : null,
      },
      sensors: [...sensors.values()].map((rt) => ({
        id: rt.row.id,
        cameraId: rt.row.cameraId,
        config: rt.row.config,
        state: rt.consensus.current,
        since: rt.since,
        candidate: rt.consensus.candidate,
        problem: problemOf(rt),
        model: rt.model,
        images: imagesOf(rt),
        job: rt.job,
        recent: rt.recent,
      })),
    };
  }

  const timer = setInterval(refreshProblems, TICK_MS);

  return {
    workerSpecs,
    offerJpeg,
    sync,
    list,
    prune,
    diagnostics,
    routes,
    async stop() {
      clearInterval(timer);
      link.stop();
    },
  };
}
