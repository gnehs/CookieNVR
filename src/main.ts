import { mkdirSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import index from "../web/index.html";
import pkg from "../package.json";
import { backupOnce } from "./backup/index.ts";
import type { CameraDto, ProbeResult, SystemDto } from "./api-types.ts";
import { createAuth } from "./auth/index.ts";
import { probeCamera } from "./camera/probe.ts";
import { createSnapshots } from "./camera/snapshot.ts";
import { openDb } from "./db.ts";
import { buildDiagnostics } from "./diagnostics.ts";
import { eventRoutes } from "./events/index.ts";
import { createExports, exportRoutes } from "./export/index.ts";
import { readEnv } from "./env.ts";
import { coreRoutes, createRouter, HttpError, redactConfig } from "./http/index.ts";
import { createLive } from "./live/live.ts";
import { queryEvents } from "./events/store.ts";
import {
  createIndexer,
  createRetention,
  ensureDayDirs,
  isRecording,
  purgeCamera,
  purgeOrphans,
  recordingRoutes,
  recordWorkerSpec,
  usageByCamera,
} from "./recording/index.ts";
import { createPtzHub, ptzRoutes } from "./ptz/index.ts";
import { createRestream, sourceUrls } from "./restream/index.ts";
import { createCameraStore, createSettingsStore } from "./stores/index.ts";
import { createStreamHub, type StreamClient } from "./stream/hub.ts";
import type { Camera, CameraConnection, CameraId, WorkerSpec } from "./types.ts";
import { createMemoryMonitor } from "./workers/memory.ts";
import { pruneRestartLog, readRestartLog } from "./workers/restart-log.ts";
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
const cameras = createCameraStore(db);
const settings = createSettingsStore(db, env.dataDir);
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
const retention = createRetention({ db, settings: settings.get });

function log(scope: string, error: unknown): void {
  console.error(`[${scope}]`, error instanceof Error ? error.message : error);
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
  const specs = [restream.workerSpec(), ...live.workerSpecs()];
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
}

async function system(): Promise<SystemDto> {
  const path = settings.get().storagePath;
  mkdirSync(path, { recursive: true });
  const fs = await statfs(path);
  return {
    workers: supervisor.status(),
    disk: { path, totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize },
    usage: usageByCamera(db),
    logs: readRestartLog(logDir, 100).map((r) => {
      const tail = r.stderrTail.at(-1);
      return `${new Date(r.at).toISOString()} ${r.id} 重啟（${r.reason}，exit ${r.exitCode ?? r.signal ?? "?"}）${tail ? `：${tail}` : ""}`;
    }),
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

function cameraDto(camera: Camera, client: StreamClient): CameraDto {
  return {
    id: camera.id,
    position: camera.position,
    config: client.principal.role === "admin" ? camera.config : redactConfig(camera.config),
    ...cameraStatus(camera.id),
    rtsp: rtspUrls(camera.id, client.req),
  };
}

const hub = createStreamHub({
  snapshot: (client) => ({
    cameras: cameras.list().map((c) => cameraDto(c, client)),
    workers: client.principal.role === "admin" ? supervisor.status() : null,
    events: queryEvents(db, { cameraId: null, startMs: Date.now(), endMs: Date.now() + 1, limit: 100 }).filter((e) => e.endMs === null),
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
  if (only !== null && !list.some((c) => c.id === only)) throw new HttpError(404, "找不到攝影機");
  const sys = await system();
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
      })),
    ),
    only: only as CameraId | null,
    workers: sys.workers,
    restarts: readRestartLog(logDir, 50),
    disk: sys.disk,
    usage: sys.usage,
  });
}

const routes = [
  ...coreRoutes({
    auth,
    cameras,
    settings,
    version: pkg.version,
    system,
    diagnostics,
    probe,
    cameraStatus,
    rtspUrls,
    purgeRecordings: purgeCameraRecordings,
    supervisor: {
      restart(id, reason) {
        if (!supervisor.status().some((w) => w.id === id)) throw new HttpError(404, "找不到這個 worker");
        supervisor.restart(id, reason);
      },
    },
  }),
  ...recordingRoutes({
    db,
    purgeOrphans: () =>
      indexer.exclusive(() => purgeOrphans(purgeDeps, (id) => cameras.get(id) !== null || hasRecordWorker(id))),
  }),
  ...eventRoutes({ db, dataDir: env.dataDir }),
  ...exportRoutes(exportJobs),
  ...ptzRoutes({ hub: ptz }),
  createSnapshots({
    env,
    sourceUrl: (id) => {
      const camera = cameras.get(id);
      if (!camera?.config.enabled) return null;
      const hasSub = sourceUrls(camera.config.connection).sub !== null;
      return restream.internalUrl(id, hasSub ? "sub" : "main");
    },
  }).route(),
  ...live.routes(),
  hub.route(),
  restream.rtspAuthRoute({
    verify: async (username, secret) => (await auth.verifyCredentials(username, secret)) !== null,
    externalEnabled: () => settings.get().rtsp.externalEnabled,
  }),
];

const server = Bun.serve({
  port: env.port,
  development: process.env.NODE_ENV !== "production",
  // 即時串流與 SSE 是長連線；預設 10 秒沒有資料就斷線，比 SSE 的 20 秒 ping 還短
  idleTimeout: 60,
  routes: { "/": index },
  fetch: createRouter(routes, auth),
});

await supervisor.ready;
await ensureDayDirs(cameras.list(), settings.get(), Date.now());
await indexer.reconcile(Date.now());
supervisor.apply(desiredWorkers());
void restream.sync(cameras.list()).catch((e) => log("restream", e));

cameras.subscribe((list) => {
  ptz.reconcile(list);
  for (const c of list) sentStatus.set(c.id, JSON.stringify(cameraStatus(c.id)));
  hub.publish((client) => ({ type: "cameras", data: list.map((c) => cameraDto(c, client)) }));
  void reconcileWorkers().catch((e) => log("workers", e));
  void restream.sync(list).catch((e) => log("restream", e));
});
supervisor.subscribe((status) => {
  hub.publish((client) => (client.principal.role === "admin" ? { type: "worker", data: status } : null));
  if (status.kind === "record") publishCameraChanges();
});
settings.subscribe(() => void reconcileWorkers().catch((e) => log("workers", e)));
const stopSync = restream.keepSynced(() => cameras.list(), ONLINE_POLL_MS, (e) => log("restream", e));

function runBackup(): void {
  try {
    backupOnce({ db, dir: join(env.dataDir, "backup") }, Date.now());
  } catch (e) {
    log("backup", e);
  }
}
runBackup();

const memory = createMemoryMonitor({
  targets: () => {
    const targets = supervisor
      .status()
      .filter((w) => w.pid !== null && (w.state === "running" || w.state === "starting"))
      .map((w) => ({ id: w.id, kind: w.kind, pid: w.pid as number }));
    const exportPid = exportJobs.activePid();
    if (exportPid !== null) targets.push({ id: "export", kind: "export", pid: exportPid });
    return targets;
  },
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

const timers = [
  setInterval(() => {
    void reconcileWorkers()
      .then(() => indexer.scanOnce(Date.now()))
      .catch((e) => log("index", e));
  }, TICK_MS),
  setInterval(() => {
    void retention.runOnce(Date.now()).catch((e) => log("retention", e));
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
  stopSync();
  void server.stop(true);
  await Promise.all([supervisor.shutdown(), exportJobs.shutdown(), ptz.dispose()]);
  db.close();
  process.exit(exitCode);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

console.log(`CookieNVR ${pkg.version} 已啟動：http://localhost:${server.port}`);
