/**
 * Main-process side of HomeKit Secure Video. Never imports HAP-NodeJS: it owns the per-camera
 * identities and stream checks on disk, runs the homekit worker and its hksv-stream ffmpeg
 * sessions through the supervisor, and talks to the worker over a loopback control connection.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Socket, TCPSocketListener } from "bun";
import type { HomekitCheckDto, HomekitDto } from "../api-types.ts";
import type { EventFeed } from "../events/tracker.ts";
import { HttpError } from "../http/errors.ts";
import { json } from "../http/respond.ts";
import { asObject, oneOf, readJson } from "../http/validate.ts";
import type { Camera, CameraId, CameraStore, Route, SettingsStore, WorkerSpec, WorkerStatus } from "../types.ts";
import { checkStream, eligibility, type StreamCheck } from "./check.ts";
import { liveCommand, recordCommand } from "./ffmpeg.ts";
import { isPaired } from "./hap-storage.ts";
import { allocatePort, createIdentity, setupUri, type HomekitIdentity } from "./identity.ts";
import { motionByCamera } from "./motion.ts";
import { encode, LineReader, parseFromWorker, type AccessoryStatus, type StreamSession, type ToWorker } from "./protocol.ts";
import { msg } from "../messages/index.ts";

const WORKER_SCRIPT = join(import.meta.dir, "worker.ts");
export const HOMEKIT_WORKER_ID = "homekit";
/** Spec: heartbeat silent for 10 s means the worker hung. */
const HEARTBEAT_STALL_MS = 10_000;
/** Spec: an hksv-stream ffmpeg with no output for 15 s hung. */
const STREAM_STALL_MS = 15_000;
/** A failed check is retried at most this often. */
const CHECK_RETRY_MS = 60_000;
const FORGET_TIMEOUT_MS = 5_000;

export interface HomekitOptions {
  dataDir: string;
  env: { ffmpegBin: string; ffprobeBin: string };
  cameras: CameraStore;
  settings: SettingsStore;
  events: EventFeed;
  /** Restream URL of the camera's main stream (with internal credentials). */
  mainUrl(id: CameraId): string;
  latestJpeg(id: CameraId): { bytes: Uint8Array; at: number } | null;
  /** The set of homekit workers changed: reconcile the supervisor. */
  onChange(): void;
  onError(scope: string, e: unknown): void;
  /** Test seams. */
  check?: (url: string) => Promise<StreamCheck>;
  isPortFree?: (port: number) => boolean;
  now?: () => number;
}

/** Per-camera HKSV report for "copy diagnostics". */
export interface HomekitCameraDiagnostics {
  enabled: boolean;
  identity: { port: number; deviceId: string } | null;
  paired: boolean;
  check: { at: number; result: StreamCheck } | { at: number; error: string } | null;
  worker: AccessoryStatus | null;
  sessions: string[];
}

export interface HomekitDiagnostics {
  systemEnabled: boolean;
  workerConnected: boolean;
  lastHeartbeatAt: number | null;
  cameras: Map<CameraId, HomekitCameraDiagnostics>;
}

export interface Homekit {
  /** Cameras or settings changed: refresh identities and the worker's config. */
  sync(): void;
  workerSpecs(): WorkerSpec[];
  /** Forward every supervisor status; failing session ffmpegs end their HomeKit session. */
  workerStatus(status: WorkerStatus): void;
  routes(): Route[];
  diagnostics(): HomekitDiagnostics;
  stop(): void;
}

type CheckEntry = { connKey: string; at: number } & ({ result: StreamCheck } | { error: string });

interface Control {
  listener: TCPSocketListener<{ reader: LineReader; authed: boolean }>;
  token: string;
  socket: Socket<{ reader: LineReader; authed: boolean }> | null;
}

const connKeyOf = (c: Camera) => JSON.stringify(c.config.connection);
const sessionWorkerId = (s: StreamSession) => (s.kind === "record" ? `hksv-record:${s.cameraId}` : `hksv-live:${s.cameraId}:${s.id}`);

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${path}.tmp`, path);
}

function defaultPortFree(port: number): boolean {
  try {
    Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
}

export function checkDto(entry: CheckEntry | null): HomekitCheckDto {
  if (!entry || !("result" in entry)) return { state: "unknown" };
  const e = eligibility(entry.result);
  return e.ok
    ? { state: "ok", keyframeIntervalSec: entry.result.keyframeIntervalSec, warning: e.warning }
    : { state: "blocked", reason: e.reason, videoCodec: entry.result.videoCodec };
}

export function createHomekit(opts: HomekitOptions): Homekit {
  const now = opts.now ?? Date.now;
  const root = join(opts.dataDir, "homekit");
  const runCheck = opts.check ?? ((url: string) => checkStream(opts.env.ffprobeBin, url, now));
  const portFree = opts.isPortFree ?? defaultPortFree;
  const dirOf = (id: CameraId) => join(root, id);
  const identityPath = (id: CameraId) => join(dirOf(id), "identity.json");
  const checkPath = (id: CameraId) => join(dirOf(id), "check.json");

  const checks = new Map<CameraId, CheckEntry>();
  const checking = new Map<CameraId, Promise<CheckEntry>>();
  let workerCameras = new Map<string, AccessoryStatus>();
  let sessions: StreamSession[] = [];
  const progressAt = new Map<string, number>();
  const restartsSeen = new Map<string, number>();
  const sentMotion = new Map<string, boolean>();
  const pendingForget = new Map<number, () => void>();
  let nextReq = 1;
  let lastHeartbeatAt: number | null = null;
  let control: Control | null = null;
  let lastSpecKey = "";

  const systemEnabled = () => opts.settings.get().homekit.enabled;
  const cameraWanted = (c: Camera) => c.config.enabled && c.config.homekit?.enabled === true;
  const wantedCameras = () => (systemEnabled() ? opts.cameras.list().filter(cameraWanted) : []);
  const connected = () => control?.socket != null;

  function loadCheck(camera: Camera): CheckEntry | null {
    let entry = checks.get(camera.id) ?? null;
    if (!entry) {
      entry = readJsonFile<CheckEntry>(checkPath(camera.id));
      if (entry) checks.set(camera.id, entry);
    }
    return entry && entry.connKey === connKeyOf(camera) ? entry : null;
  }

  /** Probes the main stream unless a result for the current connection exists. */
  function ensureCheck(camera: Camera, force = false): Promise<CheckEntry> {
    const cached = loadCheck(camera);
    const fresh = cached && ("result" in cached || now() - cached.at < CHECK_RETRY_MS);
    if (cached && fresh && !force) return Promise.resolve(cached);
    const running = checking.get(camera.id);
    if (running) return running;
    const connKey = connKeyOf(camera);
    const p = runCheck(opts.mainUrl(camera.id))
      .then((result): CheckEntry => ({ connKey, at: now(), result }), (e: Error): CheckEntry => ({ connKey, at: now(), error: e.message }))
      .then((entry) => {
        checks.set(camera.id, entry);
        // Only a successful read is worth keeping across restarts.
        if ("result" in entry) {
          try {
            writeJsonFile(checkPath(camera.id), entry);
          } catch (e) {
            opts.onError("homekit", e);
          }
        }
        checking.delete(camera.id);
        sendConfig();
        return entry;
      });
    checking.set(camera.id, p);
    return p;
  }

  function loadIdentity(id: CameraId): HomekitIdentity | null {
    return readJsonFile<HomekitIdentity>(identityPath(id));
  }

  /** Gives every wanted camera an identity whose port is unique and at or above the base. */
  function ensureIdentities(): Map<CameraId, HomekitIdentity> {
    const base = opts.settings.get().homekit.basePort;
    const out = new Map<CameraId, HomekitIdentity>();
    const wanted = opts.cameras.list().filter((c) => c.config.homekit?.enabled);
    const taken = new Set<number>();
    const pending: Camera[] = [];
    for (const c of wanted) {
      const id = loadIdentity(c.id);
      if (id && id.port >= base && !taken.has(id.port)) {
        taken.add(id.port);
        out.set(c.id, id);
      } else pending.push(c);
    }
    for (const c of pending) {
      let port = allocatePort(base, taken);
      while (port !== null && !portFree(port)) {
        taken.add(port);
        port = allocatePort(base, taken);
      }
      if (port === null) continue;
      taken.add(port);
      const identity = { ...(loadIdentity(c.id) ?? createIdentity(port)), port };
      writeJsonFile(identityPath(c.id), identity);
      out.set(c.id, identity);
    }
    return out;
  }

  function send(msg: ToWorker): void {
    if (control?.socket) control.socket.write(encode(msg));
  }

  function motionNow(): Map<string, boolean> {
    return motionByCamera(opts.events.active());
  }

  function sendConfig(): void {
    if (!connected()) return;
    const identities = ensureIdentities();
    const motion = motionNow();
    const cameras = wantedCameras().flatMap((c) => {
      const identity = identities.get(c.id);
      const entry = loadCheck(c);
      // Never publish a camera the check found ineligible; an unknown result still publishes.
      if (!identity || (entry && "result" in entry && !eligibility(entry.result).ok)) return [];
      const hasAudio = entry && "result" in entry ? entry.result.audioCodec !== null : false;
      return [{ id: c.id, name: c.config.name, identity, audio: hasAudio && c.config.record.audio, motion: motion.get(c.id) ?? false }];
    });
    for (const c of cameras) sentMotion.set(c.id, c.motion);
    send({ type: "config", cameras });
  }

  function startControl(): Control {
    const token = crypto.randomUUID();
    const ctl: Control = {
      token,
      socket: null,
      listener: Bun.listen<{ reader: LineReader; authed: boolean }>({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          open(s) {
            s.data = { reader: new LineReader(), authed: false };
          },
          data(s, chunk) {
            try {
              for (const line of s.data.reader.push(chunk)) onMessage(s, line);
            } catch (e) {
              opts.onError("homekit", e);
              s.end();
            }
          },
          close(s) {
            if (ctl.socket !== s) return;
            ctl.socket = null;
            workerCameras = new Map();
            sessions = [];
            notifyIfSpecsChanged();
          },
        },
      }),
    };
    return ctl;
  }

  function onMessage(s: NonNullable<Control["socket"]>, line: string): void {
    const msg = parseFromWorker(line);
    if (!s.data.authed) {
      if (msg.type !== "hello" || msg.token !== control?.token) throw new Error("homekit control: bad hello");
      s.data.authed = true;
      control.socket?.end();
      control.socket = s;
      lastHeartbeatAt = now();
      sendConfig();
      return;
    }
    switch (msg.type) {
      case "status":
        lastHeartbeatAt = now();
        workerCameras = new Map(msg.cameras.map((c) => [c.id, c]));
        sessions = msg.sessions;
        notifyIfSpecsChanged();
        return;
      case "snapshot": {
        const camera = opts.cameras.get(msg.cameraId as CameraId);
        const jpeg = camera ? opts.latestJpeg(camera.id) : null;
        send({ type: "snapshot", reqId: msg.reqId, jpeg: jpeg ? Buffer.from(jpeg.bytes).toString("base64") : null });
        return;
      }
      case "forgotten":
        pendingForget.get(msg.reqId)?.();
        pendingForget.delete(msg.reqId);
        return;
      case "hello":
        return;
    }
  }

  function notifyIfSpecsChanged(): void {
    const key = JSON.stringify(workerSpecs().map((s) => [s.id, s.cmd]));
    if (key === lastSpecKey) return;
    lastSpecKey = key;
    opts.onChange();
  }

  async function readProgress(id: string, stdout: ReadableStream<Uint8Array>): Promise<void> {
    progressAt.set(id, now());
    const reader = stdout.getReader();
    while (!(await reader.read()).done) progressAt.set(id, now());
  }

  function sessionSpec(s: StreamSession): WorkerSpec | null {
    const camera = opts.cameras.get(s.cameraId as CameraId);
    if (!camera || !cameraWanted(camera)) return null;
    const id = sessionWorkerId(s);
    const url = opts.mainUrl(camera.id);
    return {
      id,
      kind: "hksv-stream",
      cmd: s.kind === "live" ? liveCommand(opts.env.ffmpegBin, url, s.target) : recordCommand(opts.env.ffmpegBin, url, s.port, s.audio),
      stall: { graceMs: STREAM_STALL_MS + 5_000, intervalMs: 5_000, healthy: () => now() - (progressAt.get(id) ?? 0) < STREAM_STALL_MS },
      readStdout: (stdout) => readProgress(id, stdout),
    };
  }

  /** Only once the worker is gone: closing the connection first would make it exit as a crash. */
  function stopControl(): void {
    const ctl = control;
    control = null;
    ctl?.socket?.end();
    ctl?.listener.stop(true);
  }

  function workerSpecs(): WorkerSpec[] {
    if (wantedCameras().length === 0) return [];
    control ??= startControl();
    const ctl = control;
    const specs: WorkerSpec[] = [
      {
        id: HOMEKIT_WORKER_ID,
        kind: "homekit",
        cmd: [process.execPath, WORKER_SCRIPT],
        env: {
          HOMEKIT_CONTROL: `127.0.0.1:${ctl.listener.port}`,
          HOMEKIT_TOKEN: ctl.token,
          HOMEKIT_DIR: root,
          FFMPEG_BIN: opts.env.ffmpegBin,
        },
        stall: { graceMs: 15_000, intervalMs: 5_000, healthy: () => connected() && now() - (lastHeartbeatAt ?? 0) < HEARTBEAT_STALL_MS },
      },
    ];
    if (connected()) for (const s of sessions) {
      const spec = sessionSpec(s);
      if (spec) specs.push(spec);
    }
    return specs;
  }

  function workerStatus(status: WorkerStatus): void {
    if (status.id === HOMEKIT_WORKER_ID && status.state === "stopped" && wantedCameras().length === 0) stopControl();
    if (status.kind !== "hksv-stream") return;
    if (status.state === "stopped") {
      restartsSeen.delete(status.id);
      progressAt.delete(status.id);
      return;
    }
    const seen = restartsSeen.get(status.id) ?? 0;
    if (status.restarts <= seen) return;
    restartsSeen.set(status.id, status.restarts);
    const session = sessions.find((s) => sessionWorkerId(s) === status.id);
    if (session) send({ type: "session-failed", sessionId: session.id, error: status.stderrTail.at(-1) ?? `restarted (${status.lastRestart?.reason ?? "exit"})` });
  }

  /** Waits for the worker to unpublish and delete the pairing; then the directory is safe to drop. */
  async function forget(id: CameraId): Promise<void> {
    if (connected() && workerCameras.has(id)) {
      const reqId = nextReq++;
      await new Promise<void>((resolve) => {
        pendingForget.set(reqId, resolve);
        setTimeout(resolve, FORGET_TIMEOUT_MS);
        send({ type: "forget", cameraId: id, reqId });
      });
    }
    rmSync(dirOf(id), { recursive: true, force: true });
  }

  function dto(camera: Camera): HomekitDto {
    const enabled = camera.config.homekit?.enabled === true;
    const identity = enabled ? loadIdentity(camera.id) : null;
    const st = workerCameras.get(camera.id);
    const status: HomekitDto["status"] = !enabled || !systemEnabled() || !camera.config.enabled
      ? "off"
      : st?.published ? "ready" : st?.error ? "failed" : "starting";
    return {
      systemEnabled: systemEnabled(),
      enabled,
      check: checkDto(loadCheck(camera)),
      pairing: identity
        ? { code: identity.pincode, setupUri: setupUri(identity.pincode, identity.setupId), paired: st?.paired ?? isPaired(dirOf(camera.id), identity.username) }
        : null,
      status,
    };
  }

  function cameraOr404(id: string): Camera {
    const camera = opts.cameras.get(id as CameraId);
    if (!camera) throw new HttpError(404, msg("http.cameraNotFound"));
    return camera;
  }

  function setEnabled(camera: Camera, enabled: boolean): Camera {
    return opts.cameras.update(camera.id, { ...camera.config, homekit: { enabled } });
  }

  const getRoute: Route = {
    method: "GET",
    path: "/api/cameras/:id/homekit",
    access: "admin",
    async handler(ctx) {
      const camera = cameraOr404(ctx.params.id!);
      // The first look at a camera waits for its stream check, so the switch can say why it is off.
      if (camera.config.enabled && !loadCheck(camera)) await Promise.race([ensureCheck(camera), Bun.sleep(15_000)]);
      return json(dto(opts.cameras.get(camera.id) ?? camera));
    },
  };

  const postRoute: Route = {
    method: "POST",
    path: "/api/cameras/:id/homekit",
    access: "admin",
    async handler(ctx) {
      let camera = cameraOr404(ctx.params.id!);
      const action = oneOf(asObject(await readJson(ctx.req)), "action", ["enable", "disable", "reset"] as const);
      if (action === "enable") {
        if (!camera.config.enabled) throw new HttpError(409, msg("homekit.cameraDisabled"));
        const cached = loadCheck(camera);
        const entry = await ensureCheck(camera, !cached || !("result" in cached));
        const dtoCheck = checkDto(entry);
        if (dtoCheck.state === "unknown") throw new HttpError(409, msg("homekit.noFrame"));
        if (dtoCheck.state === "blocked") throw new HttpError(409, dtoCheck.reason === "not-h264" ? msg("homekit.notH264") : msg("homekit.noVideo"));
        camera = setEnabled(camera, true);
      } else if (action === "disable") {
        camera = setEnabled(camera, false);
      } else {
        if (!camera.config.homekit?.enabled) throw new HttpError(409, msg("homekit.notPaired"));
        await forget(camera.id);
        sync();
      }
      ensureIdentities();
      return json(dto(camera));
    },
  };

  function sync(): void {
    const list = opts.cameras.list();
    const ids = new Set(list.map((c) => c.id as string));
    // Deleted cameras take their pairing with them; ids are never reused.
    for (const id of [...checks.keys()]) if (!ids.has(id)) checks.delete(id);
    try {
      for (const entry of readdirSafe(root)) if (!ids.has(entry)) rmSync(join(root, entry), { recursive: true, force: true });
    } catch (e) {
      opts.onError("homekit", e);
    }
    for (const c of wantedCameras()) void ensureCheck(c).catch((e) => opts.onError("homekit", e));
    try {
      ensureIdentities();
    } catch (e) {
      opts.onError("homekit", e);
    }
    sendConfig();
    notifyIfSpecsChanged();
  }

  const unsubscribe = opts.events.subscribe(({ phase, event }) => {
    if (phase === "update") return;
    const active = motionNow().get(event.cameraId) ?? false;
    if (sentMotion.get(event.cameraId) === active) return;
    sentMotion.set(event.cameraId, active);
    send({ type: "motion", cameraId: event.cameraId, active });
  });

  return {
    sync,
    workerSpecs,
    workerStatus,
    routes: () => [getRoute, postRoute],
    diagnostics() {
      const cameras = new Map<CameraId, HomekitCameraDiagnostics>();
      for (const c of opts.cameras.list()) {
        const identity = c.config.homekit?.enabled ? loadIdentity(c.id) : null;
        const entry = loadCheck(c);
        cameras.set(c.id, {
          enabled: c.config.homekit?.enabled === true,
          identity: identity && { port: identity.port, deviceId: identity.username },
          paired: identity ? (workerCameras.get(c.id)?.paired ?? isPaired(dirOf(c.id), identity.username)) : false,
          check: entry && ("result" in entry ? { at: entry.at, result: entry.result } : { at: entry.at, error: entry.error }),
          worker: workerCameras.get(c.id) ?? null,
          sessions: sessions.filter((s) => s.cameraId === c.id).map((s) => `${s.kind} ${sessionWorkerId(s)}`),
        });
      }
      return { systemEnabled: systemEnabled(), workerConnected: connected(), lastHeartbeatAt, cameras };
    },
    stop() {
      unsubscribe();
      stopControl();
    },
  };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
