import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../env.ts";
import type { Camera, CameraId, Route, StreamName, Unsubscribe, WorkerSpec } from "../types.ts";
import { buildRtspAuthRoute, type RtspAuthDeps } from "./auth-route.ts";
import { renderMediamtxConfig } from "./mediamtx-config.ts";
import { hostForUrl, sourceUrls } from "./source-urls.ts";

export interface RestreamOptions {
  env: Env;
  /** 放 mediamtx.yml 的目錄 */
  configDir: string;
  /** MediaMTX 每次連線都會 POST 到這裡，例如 http://127.0.0.1:8765/internal/rtsp-auth */
  authUrl: string;
  rtspPort?: number;
  apiPort?: number;
  /** sync 等待 MediaMTX 起來的上限 */
  retryTimeoutMs?: number;
}

export interface Restream {
  workerSpec(): WorkerSpec;
  /** 把 MediaMTX 的 path 對帳成 cameras 的樣子；MediaMTX 還沒起來時會重試，逾時才丟錯 */
  sync(cameras: Camera[]): Promise<void>;
  /**
   * 定期對帳，補回 MediaMTX 重啟後消失的 path。
   * 每次都向 getCameras 取最新清單，所以也會收斂 sync 沒做完的差異。
   */
  keepSynced(getCameras: () => Camera[], intervalMs?: number, onError?: (e: unknown) => void): Unsubscribe;
  internalUrl(cameraId: CameraId, stream: StreamName): string;
  externalUrl(host: string, cameraId: CameraId, stream: StreamName): string;
  isReady(cameraId: CameraId, stream: StreamName): Promise<boolean>;
  rtspAuthRoute(deps: RtspAuthDeps): Route;
}

interface PathConf {
  source: string;
  sourceOnDemand: boolean;
  rtspTransport: "tcp" | "udp";
}

interface ListedPath extends Partial<PathConf> {
  name: string;
}

const STREAMS: StreamName[] = ["main", "sub"];

function desiredPaths(cameras: Camera[]): Map<string, PathConf> {
  const out = new Map<string, PathConf>();
  for (const cam of cameras) {
    if (!cam.config.enabled) continue;
    const conn = cam.config.connection;
    const urls = sourceUrls(conn);
    const rtspTransport = conn.type === "rtsp" ? conn.transport : "tcp";
    for (const stream of STREAMS) {
      const source = urls[stream];
      if (source === null) continue;
      out.set(`${cam.id}/${stream}`, { source, sourceOnDemand: false, rtspTransport });
    }
  }
  return out;
}

// Control API 回傳的 source 會把帳密遮成 <redacted>，無法直接和我們送出的網址比對，
// 所以用「上次成功套用的內容」判斷來源有沒有變。
function upToDate(existing: ListedPath, want: PathConf, applied: PathConf | undefined): boolean {
  return (
    applied?.source === want.source &&
    existing.sourceOnDemand === want.sourceOnDemand &&
    existing.rtspTransport === want.rtspTransport
  );
}

export function createRestream(opts: RestreamOptions): Restream {
  const rtspPort = opts.rtspPort ?? opts.env.rtspPort;
  const apiPort = opts.apiPort ?? 9997;
  const api = `http://127.0.0.1:${apiPort}`;
  const retryTimeoutMs = opts.retryTimeoutMs ?? 30_000;
  const internal = { username: `nvr-${randomBytes(4).toString("hex")}`, secret: randomBytes(24).toString("hex") };
  const configPath = join(opts.configDir, "mediamtx.yml");

  const pathApi = (op: string, name: string) =>
    `${api}/v3/config/paths/${op}/${name.split("/").map(encodeURIComponent).join("/")}`;

  async function call(url: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`MediaMTX API ${init?.method ?? "GET"} ${url} 回應 ${res.status}`);
    return res;
  }

  async function listPaths(): Promise<ListedPath[]> {
    const items: ListedPath[] = [];
    for (let page = 0; ; page++) {
      const res = await call(`${api}/v3/config/paths/list?itemsPerPage=100&page=${page}`);
      const body = (await res.json()) as { pageCount: number; items: ListedPath[] };
      items.push(...body.items);
      if (page + 1 >= body.pageCount) return items;
    }
  }

  const applied = new Map<string, PathConf>();

  async function applyOnce(cameras: Camera[]): Promise<void> {
    const want = desiredPaths(cameras);
    const have = new Map(
      (await listPaths()).filter((p) => p.name !== "all_others").map((p) => [p.name, p]),
    );

    for (const name of have.keys()) {
      if (!want.has(name)) {
        await call(pathApi("delete", name), { method: "DELETE" });
        applied.delete(name);
      }
    }
    for (const [name, conf] of want) {
      const existing = have.get(name);
      if (existing !== undefined && upToDate(existing, conf, applied.get(name))) continue;
      await call(pathApi(existing === undefined ? "add" : "replace", name), jsonBody("POST", conf));
      applied.set(name, conf);
    }
  }

  // 所有對 Control API 的寫入排成一條，避免兩次對帳同時 add 同一個 path
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  let latest: Camera[] = [];

  return {
    workerSpec() {
      mkdirSync(opts.configDir, { recursive: true });
      // MediaMTX 會監看設定檔，任何寫入（即使內容相同）都會熱重載並丟掉 API 動態加入的 path
      const config = renderMediamtxConfig({ rtspPort, apiPort, authUrl: opts.authUrl });
      if (!existsSync(configPath) || readFileSync(configPath, "utf8") !== config) writeFileSync(configPath, config);
      return {
        id: "restream",
        kind: "restream",
        cmd: [opts.env.mediamtxBin, configPath],
        stall: {
          intervalMs: 5_000,
          graceMs: 10_000,
          healthy: async () => {
            try {
              await fetch(`${api}/v3/info`, { signal: AbortSignal.timeout(10_000) });
              return true;
            } catch {
              return false;
            }
          },
        },
      };
    },

    sync(cameras) {
      latest = cameras;
      return serialized(async () => {
        const deadline = Date.now() + retryTimeoutMs;
        for (let delay = 250; ; delay = Math.min(delay * 2, 2_000)) {
          try {
            return await applyOnce(latest);
          } catch (e) {
            if (Date.now() + delay > deadline) throw e;
            await Bun.sleep(delay);
          }
        }
      });
    },

    keepSynced(getCameras, intervalMs = 5_000, onError) {
      let pending = false;
      const timer = setInterval(() => {
        if (pending) return;
        pending = true;
        latest = getCameras();
        serialized(() => applyOnce(latest))
          .catch((e) => onError?.(e))
          .finally(() => {
            pending = false;
          });
      }, intervalMs);
      return () => clearInterval(timer);
    },

    internalUrl(cameraId, stream) {
      return `rtsp://${internal.username}:${internal.secret}@127.0.0.1:${rtspPort}/${cameraId}/${stream}`;
    },

    externalUrl(host, cameraId, stream) {
      return `rtsp://${hostForUrl(host)}:${rtspPort}/${cameraId}/${stream}`;
    },

    async isReady(cameraId, stream) {
      try {
        const res = await fetch(`${api}/v3/paths/get/${encodeURIComponent(cameraId)}/${stream}`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return false;
        return ((await res.json()) as { ready?: boolean }).ready === true;
      } catch {
        return false;
      }
    },

    rtspAuthRoute(deps) {
      return buildRtspAuthRoute(internal, deps);
    },
  };
}

function jsonBody(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
