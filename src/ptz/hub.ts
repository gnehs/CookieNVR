import { HttpError } from "../http/errors.ts";
import {
  getPresets,
  gotoPreset,
  isOnvifError,
  OnvifClient,
  PtzController,
  removePreset,
  setPreset,
  stop,
  type OnvifErrorKind,
  type PtzCapabilities,
  type PtzMoveKind,
  type PtzPreset,
} from "../onvif/index.ts";
import type { Camera, CameraId, CameraStore, OnvifEndpoint, PtzMode } from "../types.ts";
import { onvifEndpointOf, ptzPrefsOf } from "./config.ts";
import { toHttpError } from "./errors.ts";
import { MotionTracker } from "./motion.ts";

export const DEFAULT_IDLE_STOP_MS = 1_500;
/** 關閉時等 Stop 送出去的上限，相機不回應也不能卡住結束 */
const RELEASE_WAIT_MS = 2_000;

export interface PtzMove {
  pan: number;
  tilt: number;
  zoom: number;
  /** 沒給就用攝影機的偏好 */
  speed?: number;
  mode?: PtzMode;
}

export type PtzInfo =
  | { supported: false; reason: "no-onvif" | "no-ptz" }
  | {
      supported: true;
      caps: Pick<PtzCapabilities, "continuous" | "relative" | "zoom" | "maxPresets">;
      presets: PtzPreset[];
      prefs: { mode: PtzMode; speed: number };
    };

/** 診斷報告用。不連線就能取得的部分；caps 沒連上過時是 "unknown" */
export interface PtzDiagnostics {
  configured: boolean;
  caps: "unknown" | "no-ptz" | PtzCapabilities;
  prefs: { mode: PtzMode; speed: number };
  lastError: { kind: OnvifErrorKind; at: number } | null;
  lastOkAt: number | null;
}

export interface PtzHubOptions {
  cameras: Pick<CameraStore, "get">;
  now?: () => number;
  idleStopMs?: number;
  fetch?: typeof fetch;
  /** ONVIF 單一請求的時間上限 */
  timeoutMs?: number;
  /** 背景送出的安全停止失敗時呼叫 */
  onError?: (id: CameraId, err: unknown) => void;
}

export interface PtzHub {
  info(id: CameraId): Promise<PtzInfo>;
  /** 回傳實際使用的移動方式 */
  move(id: CameraId, move: PtzMove): Promise<PtzMoveKind>;
  stop(id: CameraId): Promise<void>;
  gotoPreset(id: CameraId, token: string, speed?: number): Promise<void>;
  /** 沒給 token 是新增，給了是覆寫；回傳預置點 token 與最新清單 */
  savePreset(id: CameraId, name: string, token?: string): Promise<{ token: string; presets: PtzPreset[] }>;
  removePreset(id: CameraId, token: string): Promise<PtzPreset[]>;
  /** 鏡頭正在移動，或剛停止不到 3 秒 */
  isBusy(id: CameraId): boolean;
  /** 攝影機清單變動後呼叫：已刪除或連線設定變了的，釋放它的控制器 */
  reconcile(cameras: Camera[]): void;
  /** 探測並記下這台的能力與錯誤，給診斷報告用；不丟錯，超過 waitMs 就用目前已知的 */
  inspect(id: CameraId, waitMs: number): Promise<PtzDiagnostics>;
  /** 釋放所有控制器；移動中的先送 Stop */
  dispose(): Promise<void>;
}

interface Entry {
  key: string;
  client: OnvifClient;
  /** 每種移動模式一個長期存在的控制器，自動模式學到的結果與安全停止的計時才會延續 */
  controllers: Map<PtzMode, PtzController>;
  caps: PtzCapabilities | null | undefined;
  lastError: { kind: OnvifErrorKind; at: number } | null;
  lastOkAt: number | null;
}

const keyOf = (e: OnvifEndpoint) => JSON.stringify([e.host, e.port, e.username, e.password]);

const noOnvif = () => new HttpError(409, "這台相機沒有設定 ONVIF，無法控制鏡頭");
const noPtz = () => new HttpError(409, "這台相機沒有鏡頭控制功能");

export function createPtzHub(opts: PtzHubOptions): PtzHub {
  const now = opts.now ?? Date.now;
  const idleStopMs = opts.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
  const motion = new MotionTracker(now, idleStopMs);
  const entries = new Map<CameraId, Entry>();

  function camera(id: CameraId): Camera {
    const c = opts.cameras.get(id);
    if (!c) throw new HttpError(404, "找不到攝影機");
    return c;
  }

  function entryFor(id: CameraId, c: Camera): Entry | null {
    const endpoint = onvifEndpointOf(c.config.connection);
    const existing = entries.get(id);
    if (!endpoint) {
      if (existing) release(id);
      return null;
    }
    const key = keyOf(endpoint);
    if (existing?.key === key) return existing;
    if (existing) release(id);
    const entry: Entry = {
      key,
      client: new OnvifClient(endpoint, { fetch: opts.fetch, timeoutMs: opts.timeoutMs }),
      controllers: new Map(),
      caps: undefined,
      lastError: null,
      lastOkAt: null,
    };
    entries.set(id, entry);
    return entry;
  }

  function controllerFor(id: CameraId, entry: Entry, mode: PtzMode): PtzController {
    let controller = entry.controllers.get(mode);
    if (!controller) {
      controller = new PtzController(entry.client, {
        mode,
        idleStopMs,
        onError: (err) => {
          noteError(entry, err);
          opts.onError?.(id, err);
        },
      });
      entry.controllers.set(mode, controller);
    }
    return controller;
  }

  function noteError(entry: Entry, err: unknown): void {
    if (isOnvifError(err)) entry.lastError = { kind: err.kind, at: now() };
  }

  async function call<T>(entry: Entry, fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      entry.lastOkAt = now();
      return result;
    } catch (err) {
      noteError(entry, err);
      throw toHttpError(err);
    }
  }

  async function capsOf(entry: Entry): Promise<PtzCapabilities | null> {
    const caps = await call(entry, () => entry.client.capabilities());
    entry.caps = caps.ptz;
    return caps.ptz;
  }

  /** 沒有 ONVIF 或沒有 PTZ 就以 409 結束 */
  async function requirePtz(id: CameraId): Promise<{ c: Camera; entry: Entry; caps: PtzCapabilities }> {
    const c = camera(id);
    const entry = entryFor(id, c);
    if (!entry) throw noOnvif();
    const caps = await capsOf(entry);
    if (!caps) throw noPtz();
    return { c, entry, caps };
  }

  /** 移動中的先送 Stop，再丟棄；Stop 失敗不影響釋放 */
  function release(id: CameraId): Promise<void> {
    const entry = entries.get(id);
    entries.delete(id);
    motion.forget(id);
    if (!entry) return Promise.resolve();
    const armed = [...entry.controllers.values()].some((c) => c.safeStopState === "armed");
    for (const c of entry.controllers.values()) c.dispose();
    return armed ? stop(entry.client).catch(() => {}) : Promise.resolve();
  }

  return {
    async info(id) {
      const c = camera(id);
      const entry = entryFor(id, c);
      if (!entry) return { supported: false, reason: "no-onvif" };
      const caps = await capsOf(entry);
      if (!caps) return { supported: false, reason: "no-ptz" };
      const presets = await call(entry, () => getPresets(entry.client));
      return {
        supported: true,
        caps: { continuous: caps.continuous, relative: caps.relative, zoom: caps.zoom, maxPresets: caps.maxPresets },
        presets,
        prefs: ptzPrefsOf(c.config),
      };
    },

    async move(id, move) {
      const { c, entry, caps } = await requirePtz(id);
      const prefs = ptzPrefsOf(c.config);
      const mode = move.mode ?? prefs.mode;
      if (move.zoom !== 0 && !caps.zoom) throw new HttpError(409, "這台相機沒有變焦功能");
      if (mode === "continuous" && !caps.continuous) throw new HttpError(409, "這台相機不支援持續移動，請改用微調或自動模式");
      if (mode === "relative" && !caps.relative) throw new HttpError(409, "這台相機不支援微調，請改用持續移動或自動模式");
      const controller = controllerFor(id, entry, mode);
      const kind = await call(entry, () => controller.move(move, move.speed ?? prefs.speed));
      if (kind === "continuous") motion.continuousMove(id);
      else motion.settle(id);
      return kind;
    },

    async stop(id) {
      const { entry } = await requirePtz(id);
      for (const controller of entry.controllers.values()) controller.dispose();
      await call(entry, () => stop(entry.client));
      motion.settle(id);
    },

    async gotoPreset(id, token, speed) {
      const { c, entry } = await requirePtz(id);
      await call(entry, () => gotoPreset(entry.client, token, speed ?? ptzPrefsOf(c.config).speed));
      motion.settle(id);
    },

    async savePreset(id, name, token) {
      const { entry, caps } = await requirePtz(id);
      const existing = await call(entry, () => getPresets(entry.client));
      if (token !== undefined) {
        if (!existing.some((p) => p.token === token)) throw new HttpError(404, "找不到這個預置點");
      } else if (caps.maxPresets !== null && existing.length >= caps.maxPresets) {
        throw new HttpError(409, `預置點已滿，這台相機最多 ${caps.maxPresets} 個，請先刪除一個`);
      }
      const saved = await call(entry, () => setPreset(entry.client, name, token));
      return { token: saved, presets: await call(entry, () => getPresets(entry.client)) };
    },

    async removePreset(id, token) {
      const { entry } = await requirePtz(id);
      const existing = await call(entry, () => getPresets(entry.client));
      if (!existing.some((p) => p.token === token)) throw new HttpError(404, "找不到這個預置點");
      await call(entry, () => removePreset(entry.client, token));
      return call(entry, () => getPresets(entry.client));
    },

    isBusy: (id) => motion.isBusy(id),

    reconcile(cameras) {
      const live = new Map(cameras.map((c) => [c.id, c]));
      for (const [id, entry] of entries) {
        const c = live.get(id);
        const endpoint = c && onvifEndpointOf(c.config.connection);
        if (!endpoint || keyOf(endpoint) !== entry.key) void release(id);
      }
    },

    async inspect(id, waitMs) {
      const c = camera(id);
      const entry = entryFor(id, c);
      const prefs = ptzPrefsOf(c.config);
      if (!entry) return { configured: false, caps: "unknown", prefs, lastError: null, lastOkAt: null };
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        capsOf(entry).catch(() => {}),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs))),
      ]);
      clearTimeout(timer);
      return {
        configured: true,
        caps: entry.caps === undefined ? "unknown" : (entry.caps ?? "no-ptz"),
        prefs,
        lastError: entry.lastError,
        lastOkAt: entry.lastOkAt,
      };
    },

    async dispose() {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, RELEASE_WAIT_MS).unref());
      await Promise.race([Promise.all([...entries.keys()].map(release)), timeout]);
    },
  };
}
