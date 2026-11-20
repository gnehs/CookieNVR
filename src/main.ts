import { mkdirSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../package.json";
import { backupOnce } from "./backup/index.ts";
import { API_VERSION, type CameraDto, type ProbeResult, type SystemDto } from "./api-types.ts";
import { createAuth } from "./auth/index.ts";
import { createLinkService } from "./auth/link.ts";
import { probeCamera } from "./camera/probe.ts";
import { openDb } from "./db.ts";
import { buildDiagnostics, redact } from "./diagnostics.ts";
import { createDetection } from "./detect/manager.ts";
import { createEventTracker, eventRoutes } from "./events/index.ts";
import { countEventsSince } from "./events/store.ts";
import { createExports, exportRoutes } from "./export/index.ts";
import { hostLabel, instanceLabel, loadInstanceId, startMdns, type MdnsResponder } from "./discovery/index.ts";
import { portInUseMessage, readEnv, recordPermissionMessage } from "./env.ts";
import { defaultRecordingsDir } from "./recordings-dir.ts";
import { measureDisks, splitUsage } from "./storage.ts";
import { createHomekit } from "./homekit/manager.ts";
import type { CodecName } from "./hwcodec/commands.ts";
import { planDecode } from "./hwcodec/plan.ts";
import { createVideoCodecs, decodeStatusDto } from "./hwcodec/service.ts";
import { coreRoutes, createRouter, HttpError, linkRoutes, redactConfig } from "./http/index.ts";
import { webApp } from "./http/web-app.ts";
import { createLive } from "./live/live.ts";
import { metricsRoutes } from "./metrics/routes.ts";
import { createMetrics } from "./metrics/sampler.ts";
import { mergeCameraConfig, publicCameraConfig } from "./objects/config.ts";
import { createObjectDetection } from "./objects/service.ts";
import {
  createIndexer,
  createRetention,
  ensureDayDirs,
  isRecording,
  purgeCamera,
  purgeOrphans,
  recordingRoutes,
  recordWorkerSpec,
  usageByRoot,
} from "./recording/index.ts";
import { msg } from "./messages/index.ts";
import { createPtzHub, ptzRoutes } from "./ptz/index.ts";
import { createRestream, sourceUrls } from "./restream/index.ts";
import { createCameraStore, createSettingsStore, followRecordingsDefault } from "./stores/index.ts";
import { createStateClassification } from "./states/service.ts";
import { segmentsInRange } from "./recording/store.ts";
import { createStreamHub, type StreamClient } from "./stream/hub.ts";
import type { Camera, CameraConfig, CameraConnection, CameraId, WorkerSpec, WorkerStatus } from "./types.ts";
import { createMemoryMonitor, type MemoryTarget } from "./workers/memory.ts";
import { pruneRestartLog, readRestartLog } from "./workers/restart-log.ts";
import { createFailureLog, REPEAT_MS } from "./workers/failure-log.ts";
import { createSupervisor } from "./workers/supervisor.ts";

const TICK_MS = 10_000;
const RETENTION_MS = 60_000;
const ONLINE_POLL_MS = 5_000;
const BACKUP_CHECK_MS = 60 * 60_000;
const EXPORT_SWEEP_MS = 60_000;
const PTZ_INSPECT_MS = 3_000;

const env = readEnv();
const logDir = join(env.dataDir, "logs");
mkdirSync(logDir, { recursive: true });

const db = openDb(join(env.dataDir, "cookienvr.db"));
const auth = createAuth({ db });
const instanceId = loadInstanceId(db);
const links = createLinkService({ tokens: auth });
const cameras = createCameraStore(db);
const recordingsDir = defaultRecordingsDir(env);
const previousRecordingsDir = followRecordingsDefault(db, env.dataDir, recordingsDir);
if (previousRecordingsDir) {
  console.log(`[storage] 錄影位置改成 ${recordingsDir}：原本自動放在 ${previousRecordingsDir}，現在有${env.recordingsDir ? "設定 RECORDINGS_DIR" : "另外掛載的 /recordings"}。舊的錄影留在原處，照常可以回放，並照保留天數清除`);
}
const settings = createSettingsStore(db, env.dataDir, recordingsDir);
const supervisor = createSupervisor({ logDir });
const restream = createRestream({
  env,
  configDir: join(env.dataDir, "mediamtx"),
  apiPort: env.mediamtxApiPort,
  authUrl: `http://127.0.0.1:${env.port}/internal/rtsp-auth`,
});
const exportsDir = join(env.dataDir, "exports");
mkdirSync(exportsDir, { recursive: true });
const exportJobs = createExports({
  db,
  cameras,
  env,
  dir: exportsDir,
  pidFile: join(logDir, "export.pid.json"),
  freeBytes: async () => {
    const fs = await statfs(exportsDir);
    return fs.bavail * fs.bsize;
  },
});
const ptz = createPtzHub({ cameras, onError: (id, e) => log(`ptz:${id}`, e) });
const live = createLive({
  env,
  source(id, quality) {
    const camera = cameras.get(id);
    if (!camera?.config.enabled) return null;
    const hasSub = sourceUrls(camera.config.connection).sub !== null;
    const stream = quality === "hd" || !hasSub ? "main" : "sub";
    return { stream, url: restream.internalUrl(id, stream) };
  },
  onChange: () => void reconcileWorkers().catch((e) => log("workers", e)),
});
const indexer = createIndexer({ db, settings: settings.get });
const retention = createRetention({ db, settings: settings.get, dataDir: env.dataDir });
const events = createEventTracker({
  db,
  dataDir: env.dataDir,
  onError: (e) => log("events", e),
  filterWindow: (id) => objects.filterWindow(id),
});
const objects = createObjectDetection({
  env,
  settings: () => settings.get(),
  cameras: () => cameras.list(),
  events,
  onError: log,
});
/** detect worker 讀的碼流：有子碼流用子碼流 */
const detectStream = (camera: Camera) => (sourceUrls(camera.config.connection).sub !== null ? "sub" : "main");
// 試跑結果出來、或碼流格式變了，detect worker 的解碼規劃可能不同，下一次對帳就會套用
const videoCodecs = createVideoCodecs({
  env,
  tmpDir: join(env.dataDir, "tmp", "hwcodec"),
  onProbed: () => void reconcileWorkers().catch((e) => log("workers", e)),
  onError: (e) => log("hwcodec", e),
});
/** 每台 detect 碼流的影像格式（MediaMTX 回報）；只有選了硬體解碼才查 */
const detectCodecs = new Map<CameraId, CodecName | null>();
const usesHwDecode = () => settings.get().devices.decode !== "cpu";
const detection = createDetection({
  env,
  controlDir: join(env.dataDir, "detect"),
  events,
  sourceUrl(camera) {
    if (!camera.config.enabled) return null;
    return restream.internalUrl(camera.id, detectStream(camera));
  },
  decodePlan: (camera) => planDecode(settings.get().devices.decode, videoCodecs.current()?.devices ?? null, detectCodecs.get(camera.id) ?? null),
  isBusy: (id) => ptz.isBusy(id),
  jpegFps: (camera) => objects.jpegFps(camera),
  onJpeg: (id, jpeg, at) => {
    objects.offerJpeg(id, jpeg, at);
    states.offerJpeg(id, jpeg, at);
  },
  onError: log,
});
const states = createStateClassification({
  db,
  env,
  cameras: () => cameras.list(),
  blocked: (id) => {
    const state = detection.diagnostics(id)?.lastFrame?.state;
    return ptz.isBusy(id) || state === "paused" || state === "light";
  },
  segments: (id) => segmentsInRange(db, id, 0, Date.now()),
  publish: (msg) => hub.publish(() => msg),
  onWorkersChanged: () => void reconcileWorkers().catch((e) => log("workers", e)),
  onError: log,
});

const homekit = createHomekit({
  dataDir: env.dataDir,
  env,
  cameras,
  settings,
  events,
  mainUrl: (id) => restream.internalUrl(id, "main"),
  latestJpeg: (id) => detection.latestJpeg(id),
  onChange: () => void reconcileWorkers().catch((e) => log("workers", e)),
  onError: log,
});

const metrics = createMetrics({ targets: () => processTargets(), gpuExtras: (gpu) => objects.gpuExtras(gpu), onError: (e) => log("metrics", e) });

/** 轉發設定同步失敗多半是 MediaMTX 還沒起來（或起不來），API 連不上；說成白話，真正的原因由 worker 失敗日誌說明 */
function logRestream(e: unknown): void {
  const refused = (e as { code?: string }).code === "ConnectionRefused" || String((e as Error)?.message ?? e).includes("ECONNREFUSED");
  log("restream", refused ? "連不到影像服務（MediaMTX），它啟動後會自動重試" : e);
}

// 週期性的工作（例如轉發設定同步）失敗時每幾秒就會重來一次；同樣的訊息隔一段時間才再印，免得蓋掉真正的說明
const loggedAt = new Map<string, number>();
function log(scope: string, error: unknown): void {
  const message = `[${scope}] ${error instanceof Error ? error.message : String(error)}`;
  const last = loggedAt.get(message);
  if (last !== undefined && Date.now() - last < REPEAT_MS) return;
  loggedAt.set(message, Date.now());
  console.error(message);
}

const purgeDeps = { db, storagePath: () => settings.get().storagePath, dataDir: env.dataDir };

const recordWorkerId = (id: CameraId) => `record:${id}`;
const hasRecordWorker = (id: CameraId) => supervisor.status().some((w) => w.id === recordWorkerId(id));

/**
 * The camera row is already gone, but its ffmpeg may still be writing until the supervisor has
 * stopped it. Purging earlier would race the writer, and the indexer would register the new
 * files again. So wait for the worker to be gone, then purge while no index scan is running.
 */
async function waitForRecordWorkerGone(id: CameraId): Promise<void> {
  while (hasRecordWorker(id)) {
    await new Promise<void>((resolve) => {
      const unsubscribe = supervisor.subscribe((s) => {
        if (s.id !== recordWorkerId(id) || s.state !== "stopped") return;
        unsubscribe();
        resolve();
      });
      if (!hasRecordWorker(id)) {
        unsubscribe();
        resolve();
      }
    });
  }
}

function purgeCameraRecordings(id: CameraId): void {
  void waitForRecordWorkerGone(id)
    .then(() => indexer.exclusive(() => purgeCamera(purgeDeps, id)))
    .catch((e) => log("purge", e));
}

function desiredWorkers(): WorkerSpec[] {
  const specs = [restream.workerSpec(), ...live.workerSpecs(), ...detection.workerSpecs(), ...homekit.workerSpecs(), ...objects.workerSpecs(), ...states.workerSpecs()];
  for (const camera of cameras.list()) {
    if (!isRecording(camera)) continue;
    const input = camera.config.record.direct
      ? sourceUrls(camera.config.connection).main
      : restream.internalUrl(camera.id, "main");
    specs.push(recordWorkerSpec(camera, settings.get(), input, env));
  }
  return specs;
}

// 目錄必須先存在，ffmpeg 才寫得進去，所以對帳 worker 一律排在建目錄之後。
async function reconcileWorkers(): Promise<void> {
  await ensureDayDirs(cameras.list(), settings.get(), Date.now());
  supervisor.apply(desiredWorkers());
}

const online = new Map<CameraId, boolean>();
async function refreshOnline(): Promise<void> {
  const list = cameras.list();
  const states = await Promise.all(list.map((c) => restream.isReady(c.id, "main")));
  online.clear();
  list.forEach((c, i) => online.set(c.id, states[i] ?? false));
  if (!usesHwDecode()) return detectCodecs.clear();
  const codecs = await Promise.all(list.map((c) => restream.videoCodec(c.id, detectStream(c))));
  detectCodecs.clear();
  // 連不上時保留 null：規劃先假設 H.264，worker 碰到不支援的格式會自己退回 CPU
  list.forEach((c, i) => detectCodecs.set(c.id, codecs[i] ?? null));
}

const decodeStatus = () => decodeStatusDto(settings.get().devices.decode, detection.decodeStatus(), (id) => cameras.get(id)?.config.name ?? id);

/** 對外的 worker 狀態：輸出尾端可能帶著串流網址裡的帳密，送出前一律遮蔽 */
const publicWorker = (w: WorkerStatus): WorkerStatus => ({ ...w, stderrTail: w.stderrTail.map((line) => redact(line, cameras.list())) });

async function system(): Promise<SystemDto> {
  const path = settings.get().storagePath;
  mkdirSync(path, { recursive: true });
  return {
    workers: supervisor.status().map(publicWorker),
    ...(await measureDisks(path, env.dataDir)),
    ...splitUsage(usageByRoot(db), path),
    logs: readRestartLog(logDir, 100).map((r) => {
      const tail = r.stderrTail.at(-1);
      return `${new Date(r.at).toISOString()} ${r.id} 重啟（${r.reason}，exit ${r.exitCode ?? r.signal ?? "?"}）${tail ? `：${tail}` : ""}`;
    }),
    decode: decodeStatus(),
  };
}

// 診斷報告用：以連線設定為 key 記住最近一次測試結果，碼流編碼與解析度只能從這裡得知
const probes = new Map<string, { at: number; result: ProbeResult }>();
async function probe(conn: CameraConnection): Promise<ProbeResult> {
  const result = await probeCamera(conn, env);
  probes.set(JSON.stringify(conn), { at: Date.now(), result });
  return result;
}

function cameraStatus(id: CameraId) {
  const isOnline = online.get(id) ?? false;
  // "starting" 涵蓋卡死偵測的 30 秒寬限期，這段時間 ffmpeg 其實已經在寫檔；
  // 以相機上線為前提，才不會把連不上而反覆重啟的 worker 當成錄影中。
  const worker = supervisor.status().find((w) => w.id === `record:${id}`);
  const active = worker?.state === "running" || worker?.state === "starting";
  return { online: isOnline, recording: isOnline && active };
}

function rtspUrls(id: CameraId, req: Request) {
  const host = new URL(req.url).hostname;
  const camera = cameras.get(id);
  const hasSub = camera !== null && sourceUrls(camera.config.connection).sub !== null;
  return {
    main: restream.externalUrl(host, id, "main"),
    sub: hasSub ? restream.externalUrl(host, id, "sub") : null,
  };
}

const publicConfig = (config: CameraConfig) => publicCameraConfig(config, settings.get().objects.enabled);

function cameraDto(camera: Camera, client: StreamClient): CameraDto {
  return {
    id: camera.id,
    position: camera.position,
    groupId: camera.groupId,
    config: publicConfig(client.principal.role === "admin" ? camera.config : redactConfig(camera.config)),
    ...cameraStatus(camera.id),
    rtsp: rtspUrls(camera.id, client.req),
  };
}

const hub = createStreamHub({
  // 撤銷或降級後切斷，讓用戶端重連時拿到新的權限
  stillAuthorized: (client) => auth.authenticate(client.req, new URL(client.req.url))?.role === client.principal.role,
  snapshot: (client) => ({
    cameras: cameras.list().map((c) => cameraDto(c, client)),
    workers: client.principal.role === "admin" ? supervisor.status().map(publicWorker) : null,
    events: events.active(),
    stateSensors: states.list(),
  }),
});

// 只推有變的那幾台；上線狀態每 5 秒更新一次，錄影狀態跟著 worker 狀態走
const sentStatus = new Map<CameraId, string>();
function publishCameraChanges(): void {
  for (const camera of cameras.list()) {
    const key = JSON.stringify(cameraStatus(camera.id));
    if (sentStatus.get(camera.id) === key) continue;
    sentStatus.set(camera.id, key);
    hub.publish((client) => ({ type: "camera", data: cameraDto(camera, client) }));
  }
}

async function diagnostics(only: string | null): Promise<string> {
  const list = cameras.list();
  if (only !== null && !list.some((c) => c.id === only)) throw new HttpError(404, msg("http.cameraNotFound"));
  const sys = await system();
  const hk = homekit.diagnostics();
  return buildDiagnostics({
    now: Date.now(),
    version: pkg.version,
    runtime: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      uptimeMs: Math.round(process.uptime() * 1000),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    settings: settings.get(),
    cameras: await Promise.all(
      list.map(async (camera) => ({
        camera,
        ...cameraStatus(camera.id),
        probe: probes.get(JSON.stringify(camera.config.connection)) ?? null,
        ptz: await ptz.inspect(camera.id, PTZ_INSPECT_MS),
        detect: { state: detection.diagnostics(camera.id), eventsLast24h: countEventsSince(db, camera.id, Date.now() - 86_400_000) },
        homekit: hk.cameras.get(camera.id),
      })),
    ),
    homekit: hk,
    only: only as CameraId | null,
    objects: objects.diagnostics(),
    states: states.diagnostics(),
    workers: sys.workers,
    restarts: readRestartLog(logDir, 50),
    disk: sys.disk,
    dataDisk: sys.dataDisk,
    usage: sys.usage,
    elsewhere: sys.elsewhere,
    metrics: await metrics.diagnostics(),
    video: { report: videoCodecs.current(), status: decodeStatus() },
  });
}

const routes = [
  ...coreRoutes({
    auth,
    cameras,
    settings,
    version: pkg.version,
    instanceId,
    system,
    diagnostics,
    probe,
    cameraStatus,
    rtspUrls,
    purgeRecordings: purgeCameraRecordings,
    publicConfig,
    mergeConfig: (incoming, existing) => mergeCameraConfig(incoming, existing, settings.get().objects.enabled),
    supervisor: {
      restart(id, reason) {
        if (!supervisor.status().some((w) => w.id === id)) throw new HttpError(404, msg("http.workerNotFound"));
        supervisor.restart(id, reason);
      },
    },
  }),
  ...recordingRoutes({
    db,
    purgeOrphans: () =>
      indexer.exclusive(() => purgeOrphans(purgeDeps, (id) => cameras.get(id) !== null || hasRecordWorker(id))),
  }),
  ...linkRoutes(links, { proveToken: auth.proveToken, instanceId }),
  ...eventRoutes({ db, dataDir: env.dataDir, events }),
  ...exportRoutes(exportJobs),
  ...ptzRoutes({ hub: ptz }),
  ...detection.routes(),
  ...objects.routes(),
  ...states.routes(),
  ...videoCodecs.routes(decodeStatus),
  ...live.routes(),
  ...homekit.routes(),
  ...metricsRoutes(metrics),
  hub.route(),
  restream.rtspAuthRoute({
    verify: async (username, secret) => (await auth.verifyCredentials(username, secret)) !== null,
    externalEnabled: () => settings.get().rtsp.externalEnabled,
  }),
];

const web = webApp(join(import.meta.dir, "../dist/web"));
if (!web.ready) console.warn("[web] 找不到 dist/web：網頁介面要先執行 bun run build（開發時用 bun run dev:web），API 照常運作");

const server = (() => {
  try {
    return Bun.serve({
      port: env.port,
      // 即時串流與 SSE 是長連線；預設 10 秒沒有資料就斷線，比 SSE 的 20 秒 ping 還短
      idleTimeout: 60,
      fetch: createRouter(routes, auth, { fallback: web.handle }),
    });
  } catch (e) {
    if ((e as { code?: string }).code !== "EADDRINUSE") throw e;
    console.error(portInUseMessage(env.port, "PORT"));
    process.exit(1);
  }
})();

await supervisor.ready;
await ensureDayDirs(cameras.list(), settings.get(), Date.now());
await indexer.reconcile(Date.now());
detection.sync(cameras.list());
states.sync(cameras.list());
homekit.sync();
supervisor.apply(desiredWorkers());
void restream.sync(cameras.list()).catch((e) => logRestream(e));
// 選了硬體解碼才試跑；跑完 onProbed 重新對帳，detect worker 在那之前先用 CPU
if (usesHwDecode()) void videoCodecs.probe().catch((e) => log("hwcodec", e));

const mdnsInfo = () => ({
  instance: instanceLabel(settings.get().siteName, instanceId),
  host: hostLabel(instanceId),
  port: env.publicPort,
  txt: { id: instanceId, version: pkg.version, api: String(API_VERSION) },
});
let mdns: MdnsResponder | null = null;
if (env.discovery) {
  try {
    mdns = await startMdns({ info: mdnsInfo, onError: (e) => log("mdns", e) });
  } catch (e) {
    // 5353 被占用且不允許共用時，自動發現停用，其他功能照常
    log("mdns", e);
  }
}

cameras.subscribeGroups((groups) => hub.publish(() => ({ type: "camera-groups", data: groups.map((g) => ({ id: g.id, name: g.name })) })));
cameras.subscribe((list) => {
  ptz.reconcile(list);
  detection.sync(list);
  states.sync(list);
  homekit.sync();
  for (const c of list) sentStatus.set(c.id, JSON.stringify(cameraStatus(c.id)));
  hub.publish((client) => ({ type: "cameras", data: list.map((c) => cameraDto(c, client)) }));
  void reconcileWorkers().catch((e) => log("workers", e));
  void restream.sync(list).catch((e) => logRestream(e));
});
// 背景服務停下來時印到容器日誌（Unraid 的 Logs 視窗只看得到這裡）；RTSP port 被佔用時直接說改法
const logWorkerFailure = createFailureLog({
  print: (line) => console.error(line),
  redact: (line) => redact(line, cameras.list()),
  explain: (status, last) => {
    if (status.kind === "restream" && last.includes("address already in use")) return portInUseMessage(env.rtspPort, "RTSP_PORT");
    if (status.kind === "record" && last.includes("Permission denied")) return recordPermissionMessage(status.id, settings.get().storagePath);
    return null;
  },
});
supervisor.subscribe((status) => {
  logWorkerFailure(status);
  hub.publish((client) => (client.principal.role === "admin" ? { type: "worker", data: publicWorker(status) } : null));
  if (status.kind === "record") publishCameraChanges();
  homekit.workerStatus(status);
});
// update 只在類別改變時推（物件辨識確認了新類別，HA 的感應器要立刻亮）；分數與縮圖的更新不推
const pushedLabels = new Map<number, string>();
events.subscribe(({ phase, event }) => {
  const labels = event.labels.join(",");
  if (phase === "update") {
    if (pushedLabels.get(event.id) === labels) return;
    pushedLabels.set(event.id, labels);
    hub.publish(() => ({ type: "event", data: { phase, event } }));
    return;
  }
  if (phase === "start") pushedLabels.set(event.id, labels);
  else pushedLabels.delete(event.id);
  hub.publish(() => ({ type: "event", data: { phase, event } }));
  hub.publish(() => ({ type: "motion", data: { cameraId: event.cameraId, active: phase === "start" } }));
});
// 物件辨識開關會改變對外的 detect.labels：重送攝影機清單
let objectsWasEnabled = settings.get().objects.enabled;
settings.subscribe((s) => {
  homekit.sync();
  if (s.devices.decode !== "cpu" && !videoCodecs.current()) void videoCodecs.probe().catch((e) => log("hwcodec", e));
  void reconcileWorkers().catch((e) => log("workers", e));
  mdns?.refresh();
  if (s.objects.enabled === objectsWasEnabled) return;
  objectsWasEnabled = s.objects.enabled;
  const list = cameras.list();
  hub.publish((client) => ({ type: "cameras", data: list.map((c) => cameraDto(c, client)) }));
});
const stopSync = restream.keepSynced(() => cameras.list(), ONLINE_POLL_MS, (e) => logRestream(e));

function runBackup(): void {
  try {
    backupOnce({ db, dir: join(env.dataDir, "backup") }, Date.now());
  } catch (e) {
    log("backup", e);
  }
}
runBackup();

/** Running process trees: the memory monitor enforces limits on them, the metrics sampler reports them. */
function processTargets(): MemoryTarget[] {
  const targets = supervisor
    .status()
    .filter((w) => w.pid !== null && (w.state === "running" || w.state === "starting"))
    .map((w) => ({ id: w.id, kind: w.kind, pid: w.pid as number }));
  const exportPid = exportJobs.activePid();
  if (exportPid !== null) targets.push({ id: "export", kind: "export", pid: exportPid });
  return targets;
}

const memory = createMemoryMonitor({
  targets: processTargets,
  onExceeded(target, rss) {
    console.error(`[memory] ${target.id} 使用 ${Math.round(rss / 1048576)} MB，超過上限，重啟`);
    if (target.id === "export") exportJobs.killForMemory();
    else supervisor.restart(target.id, "memory");
  },
  self: {
    limitBytes: env.mainMemoryLimitMb * 1048576,
    rss: () => process.memoryUsage.rss(),
    onExceeded(rss) {
      console.error(`[memory] 主程序使用 ${Math.round(rss / 1048576)} MB，超過上限 ${env.mainMemoryLimitMb} MB，收掉所有 worker 後退出`);
      void shutdown(1);
    },
  },
  onError: (e) => log("memory", e),
});
memory.start();
metrics.start();

const timers = [
  setInterval(() => {
    void reconcileWorkers()
      .then(() => indexer.scanOnce(Date.now()))
      .catch((e) => log("index", e));
  }, TICK_MS),
  setInterval(() => {
    void retention.runOnce(Date.now()).catch((e) => log("retention", e));
    const eventDays = settings.get().retention.eventDays;
    if (eventDays > 0) void states.prune(Date.now() - eventDays * 86_400_000).catch((e) => log("states", e));
    pruneRestartLog(logDir);
  }, RETENTION_MS),
  setInterval(() => {
    void refreshOnline()
      .then(publishCameraChanges)
      .catch((e) => log("online", e));
  }, ONLINE_POLL_MS),
  setInterval(runBackup, BACKUP_CHECK_MS),
  setInterval(() => void exportJobs.sweep().catch((e) => log("export", e)), EXPORT_SWEEP_MS),
];

let stopping = false;
async function shutdown(exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const t of timers) clearInterval(t);
  memory.stop();
  metrics.stop();
  stopSync();
  void server.stop(true);
  await Promise.all([mdns?.stop(), supervisor.shutdown(), exportJobs.shutdown(), ptz.dispose(), detection.stop(), objects.stop(), states.stop()]);
  homekit.stop();
  db.close();
  process.exit(exitCode);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

console.log(`CookieNVR ${pkg.version} 已啟動：http://localhost:${server.port}`);
