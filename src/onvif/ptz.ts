import type { OnvifClient, PtzCapabilities } from "./client.ts";
import { isOnvifError, OnvifError } from "./errors.ts";
import { NS, requireText } from "./soap.ts";
import { child, children, escapeXml, textOf } from "./xml.ts";

/** 各軸方向，-1 到 1 */
export interface PtzVector {
  pan: number;
  tilt: number;
  zoom: number;
}

export type PtzMoveKind = "continuous" | "relative";
export type PtzMoveMode = "auto" | PtzMoveKind;

export interface PtzPreset {
  token: string;
  name: string;
}

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 1;

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return MAX_SPEED;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

const clampAxis = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(-1, v)) : 0);
const num = (v: number) => String(Number(v.toFixed(4)));

/** PTZSpeed／PTZVector：數值為 0 的軸不送，沒有變焦的相機收到 Zoom 可能回錯 */
function vectorXml(tag: string, v: PtzVector): string {
  const parts: string[] = [];
  if (v.pan !== 0 || v.tilt !== 0) parts.push(`<tt:PanTilt x="${num(v.pan)}" y="${num(v.tilt)}"/>`);
  if (v.zoom !== 0) parts.push(`<tt:Zoom x="${num(v.zoom)}"/>`);
  return `<${tag}>${parts.join("")}</${tag}>`;
}

function speedXml(speed: number, zoom: boolean): string {
  const s = clampSpeed(speed);
  return vectorXml("Speed", { pan: s, tilt: s, zoom: zoom ? s : 0 });
}

async function requirePtz(client: OnvifClient, name: string): Promise<PtzCapabilities> {
  const caps = await client.capabilities();
  if (!caps.ptz) throw new OnvifError("protocol", `${name}：這台相機沒有 PTZ`, name);
  return caps.ptz;
}

async function ptzCall(client: OnvifClient, name: string, inner: (ptz: PtzCapabilities, token: string) => string) {
  const ptz = await requirePtz(client, name);
  const body = `<${name} xmlns="${NS.tptz}" xmlns:tt="${NS.tt}">${inner(ptz, `<ProfileToken>${escapeXml(ptz.profileToken)}</ProfileToken>`)}</${name}>`;
  return client.call("ptz", `${NS.tptz}/${name}`, name, body);
}

/** 以 direction × speed 的速度持續移動，直到 Stop */
export async function continuousMove(client: OnvifClient, direction: PtzVector, speed: number): Promise<void> {
  const s = clampSpeed(speed);
  const v = { pan: clampAxis(direction.pan) * s, tilt: clampAxis(direction.tilt) * s, zoom: clampAxis(direction.zoom) * s };
  await ptzCall(client, "ContinuousMove", (_, token) => token + vectorXml("Velocity", v));
}

/** 往 direction 方向移動 step 的距離（通用座標空間是 -1 到 1） */
export async function relativeMove(client: OnvifClient, direction: PtzVector, speed: number, step = 0.1): Promise<void> {
  const t = { pan: clampAxis(direction.pan) * step, tilt: clampAxis(direction.tilt) * step, zoom: clampAxis(direction.zoom) * step };
  await ptzCall(client, "RelativeMove", (ptz, token) => token + vectorXml("Translation", t) + speedXml(speed, ptz.zoom && t.zoom !== 0));
}

/** 只帶 ProfileToken 的 Stop 會停止所有軸（ptz.wsdl 的定義） */
export async function stop(client: OnvifClient): Promise<void> {
  await ptzCall(client, "Stop", (_, token) => token);
}

export async function getPresets(client: OnvifClient): Promise<PtzPreset[]> {
  const res = await ptzCall(client, "GetPresets", (_, token) => token);
  return children(res, "Preset").flatMap((p) => {
    const token = p.attrs.token;
    return token ? [{ token, name: textOf(child(p, "Name")) || token }] : [];
  });
}

export async function gotoPreset(client: OnvifClient, presetToken: string, speed: number): Promise<void> {
  await ptzCall(client, "GotoPreset", (ptz, token) =>
    token + `<PresetToken>${escapeXml(presetToken)}</PresetToken>` + speedXml(speed, ptz.zoom));
}

/** 不給 presetToken 時新增預置點；給了就覆寫該預置點。回傳預置點 token */
export async function setPreset(client: OnvifClient, name: string, presetToken?: string): Promise<string> {
  const res = await ptzCall(client, "SetPreset", (_, token) =>
    token +
    `<PresetName>${escapeXml(name)}</PresetName>` +
    (presetToken ? `<PresetToken>${escapeXml(presetToken)}</PresetToken>` : ""));
  return requireText(res, "SetPreset", "PresetToken");
}

export async function removePreset(client: OnvifClient, presetToken: string): Promise<void> {
  await ptzCall(client, "RemovePreset", (_, token) => token + `<PresetToken>${escapeXml(presetToken)}</PresetToken>`);
}

export interface Timer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimer: Timer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * 安全停止：每次移動後重新計時，idleMs 內沒有新的移動就觸發 onExpire（送 Stop）。
 * 前端按住時每 500 ms 送一次移動，網路斷掉時鏡頭最多再轉 idleMs。
 */
export class SafeStopWatchdog {
  private handle: unknown = null;

  constructor(
    private readonly idleMs: number,
    private readonly timer: Timer,
    private readonly onExpire: () => void,
  ) {}

  get state(): "idle" | "armed" {
    return this.handle === null ? "idle" : "armed";
  }

  moved(): void {
    this.disarm();
    this.handle = this.timer.set(() => {
      this.handle = null;
      this.onExpire();
    }, this.idleMs);
  }

  disarm(): void {
    if (this.handle !== null) this.timer.clear(this.handle);
    this.handle = null;
  }
}

export interface PtzControllerOptions {
  mode?: PtzMoveMode;
  /** 安全停止的等待時間 */
  idleStopMs?: number;
  /** 相對移動每次的距離 */
  relativeStep?: number;
  timer?: Timer;
  /** 安全停止送出的 Stop 失敗時呼叫 */
  onError?: (err: unknown) => void;
}

/**
 * 把 PTZ 指令包成前端操作：自動模式先試持續移動，相機回 Fault 就改用相對移動並記住；
 * 持續移動後掛上安全停止。
 */
export class PtzController {
  private learned: PtzMoveKind | null = null;
  private readonly watchdog: SafeStopWatchdog;
  private readonly mode: PtzMoveMode;
  private readonly relativeStep: number;
  private readonly onError: (err: unknown) => void;

  constructor(
    private readonly client: OnvifClient,
    opts: PtzControllerOptions = {},
  ) {
    this.mode = opts.mode ?? "auto";
    this.relativeStep = opts.relativeStep ?? 0.1;
    this.onError = opts.onError ?? (() => {});
    this.watchdog = new SafeStopWatchdog(opts.idleStopMs ?? 1500, opts.timer ?? realTimer, () => {
      stop(this.client).catch(this.onError);
    });
  }

  /** 自動模式學到的移動方式；還沒移動過時為 null */
  get learnedMode(): PtzMoveKind | null {
    return this.learned;
  }

  get safeStopState(): "idle" | "armed" {
    return this.watchdog.state;
  }

  /** 回傳實際使用的移動方式 */
  async move(direction: PtzVector, speed: number): Promise<PtzMoveKind> {
    const ptz = await requirePtz(this.client, "move");
    const kind = this.pickKind(ptz);
    if (kind === "relative") {
      await relativeMove(this.client, direction, speed, this.relativeStep);
      return "relative";
    }
    try {
      await continuousMove(this.client, direction, speed);
    } catch (err) {
      if (this.mode !== "auto" || !isOnvifError(err, "fault") || !ptz.relative) throw err;
      this.learned = "relative";
      await relativeMove(this.client, direction, speed, this.relativeStep);
      return "relative";
    }
    if (this.mode === "auto") this.learned = "continuous";
    this.watchdog.moved();
    return "continuous";
  }

  async stop(): Promise<void> {
    this.watchdog.disarm();
    await stop(this.client);
  }

  /** 停止計時，不送 Stop（呼叫端已另外處理或要丟棄這個控制器） */
  dispose(): void {
    this.watchdog.disarm();
  }

  private pickKind(ptz: PtzCapabilities): PtzMoveKind {
    if (this.mode !== "auto") return this.mode;
    if (this.learned) return this.learned;
    return ptz.continuous || !ptz.relative ? "continuous" : "relative";
  }
}
