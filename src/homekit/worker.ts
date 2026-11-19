// homekit worker: every HKSV-enabled camera as its own HAP accessory. Runs under the supervisor
// with env HOMEKIT_CONTROL (host:port of the main process), HOMEKIT_TOKEN, HOMEKIT_DIR, FFMPEG_BIN.
// Exits when the control connection drops; the supervisor starts it again.
import { join } from "node:path";
import pkg from "../../package.json";
import { installChaCha20Poly1305 } from "./chacha.ts";
import { compactDeviceId, createRoutedStore } from "./hap-storage.ts";
import { encode, LineReader, parseToWorker, type AccessoryConfig, type FromWorker, type ToWorker } from "./protocol.ts";
import type { CameraAccessory as CameraAccessoryType } from "./accessory.ts";

const STATUS_MS = 2_000;

const control = process.env.HOMEKIT_CONTROL ?? "";
const token = process.env.HOMEKIT_TOKEN ?? "";
const homekitDir = process.env.HOMEKIT_DIR ?? "";
const ffmpegBin = process.env.FFMPEG_BIN ?? "ffmpeg";
const [controlHost, controlPort] = [control.slice(0, control.lastIndexOf(":")), Number(control.slice(control.lastIndexOf(":") + 1))];
if (!controlHost || !controlPort || !token || !homekitDir) {
  console.error("homekit worker: HOMEKIT_CONTROL, HOMEKIT_TOKEN and HOMEKIT_DIR are required");
  process.exit(2);
}

// Must run before HAP-NodeJS loads: it checks for the cipher at import time.
installChaCha20Poly1305();
const hap = await import("hap-nodejs");
const { CameraAccessory } = await import("./accessory.ts");

const accessories = new Map<string, CameraAccessoryType>();
const dirByDeviceId = new Map<string, string>();
const store = createRoutedStore((id) => dirByDeviceId.get(id) ?? null);
// HAP-NodeJS has one process-wide store; route its keys into per-camera directories.
(hap.HAPStorage as unknown as { INSTANCE: { localStore: unknown } }).INSTANCE.localStore = store;

const log = (m: string) => console.error(`[homekit] ${m}`);
const snapshots = new Map<number, (jpeg: Uint8Array | null) => void>();
let nextReq = 1;
const reader = new LineReader();

const socket = await Bun.connect({
  hostname: controlHost,
  port: controlPort,
  socket: {
    data(_s, chunk) {
      let lines: string[];
      try {
        lines = reader.push(chunk);
      } catch (e) {
        log(`control stream: ${(e as Error).message}`);
        return void shutdown(1);
      }
      for (const line of lines) {
        try {
          void handle(parseToWorker(line));
        } catch (e) {
          log(`bad control message: ${(e as Error).message}`);
        }
      }
    },
    close() {
      log("control connection closed");
      void shutdown(1);
    },
    error(_s, e) {
      log(`control connection: ${e.message}`);
    },
  },
});
function send(msg: FromWorker): void {
  socket.write(encode(msg));
}

let statusQueued = false;
function sendStatus(): void {
  statusQueued = false;
  send({
    type: "status",
    cameras: [...accessories.values()].map((a) => a.status()),
    sessions: [...accessories.values()].flatMap((a) => a.sessions()),
  });
}
/** Coalesces bursts of changes into one status message. */
function changed(): void {
  if (statusQueued) return;
  statusQueued = true;
  queueMicrotask(sendStatus);
}

const deps = {
  hap,
  ffmpegBin,
  version: pkg.version,
  changed,
  log,
  snapshot(cameraId: string) {
    const reqId = nextReq++;
    return new Promise<Uint8Array | null>((resolve) => {
      snapshots.set(reqId, resolve);
      setTimeout(() => {
        if (snapshots.delete(reqId)) resolve(null);
      }, 5_000);
      send({ type: "snapshot", reqId, cameraId });
    });
  },
};

/** Closes still in flight; shutdown waits for them so their goodbyes go out. */
const closed = new Set<Promise<void>>();
function track(p: Promise<void>): Promise<void> {
  closed.add(p);
  return p.finally(() => closed.delete(p));
}

/** Applies a full config: new cameras published, removed ones unpublished (pairing kept). */
let applying: Promise<void> = Promise.resolve();
function applyConfig(cameras: AccessoryConfig[]): Promise<void> {
  applying = applying.then(async () => {
    const wanted = new Map(cameras.map((c) => [c.id, c]));
    for (const [id, acc] of accessories) {
      const next = wanted.get(id);
      if (next && JSON.stringify(next.identity) === JSON.stringify(acc.identity)) continue;
      accessories.delete(id);
      await track(acc.close(false));
      dirByDeviceId.delete(compactDeviceId(acc.identity.username));
    }
    for (const config of cameras) {
      const existing = accessories.get(config.id);
      if (existing) {
        existing.update(config);
        continue;
      }
      dirByDeviceId.set(compactDeviceId(config.identity.username), join(homekitDir, config.id));
      const acc = new CameraAccessory(config, deps);
      accessories.set(config.id, acc);
      await acc.publish();
    }
    changed();
  });
  return applying;
}

async function handle(msg: ToWorker): Promise<void> {
  switch (msg.type) {
    case "config":
      return applyConfig(msg.cameras);
    case "motion":
      accessories.get(msg.cameraId)?.setMotion(msg.active);
      return;
    case "snapshot": {
      const resolve = snapshots.get(msg.reqId);
      snapshots.delete(msg.reqId);
      resolve?.(msg.jpeg === null ? null : Buffer.from(msg.jpeg, "base64"));
      return;
    }
    case "forget": {
      await applying;
      const acc = accessories.get(msg.cameraId);
      if (acc) {
        accessories.delete(msg.cameraId);
        await track(acc.close(true));
        dirByDeviceId.delete(compactDeviceId(acc.identity.username));
      }
      changed();
      send({ type: "forgotten", reqId: msg.reqId });
      return;
    }
    case "session-failed":
      for (const acc of accessories.values()) acc.sessionFailed(msg.sessionId, msg.error);
      return;
  }
}

let stopping = false;
async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  // Unpublishing sends mDNS goodbye packets, so iOS and browsers drop the accessory at once.
  const closing = [...closed, ...[...accessories.values()].map((a) => a.close(false))];
  await Promise.race([Promise.all(closing), Bun.sleep(3_000)]);
  process.exit(code);
}
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));

send({ type: "hello", token });
setInterval(sendStatus, STATUS_MS);
