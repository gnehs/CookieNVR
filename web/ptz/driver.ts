import type { PtzMode } from "../../src/types.ts";

export interface Vec {
  pan: number;
  tilt: number;
  zoom: number;
}

/** hold 與 pulse 是持續移動（要送 stop），step 是一次相對移動（不用 stop） */
export type MoveKind = "hold" | "step" | "pulse";

export interface Transport {
  move(vec: Vec, kind: MoveKind): Promise<unknown>;
  stop(): Promise<unknown>;
}

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface MotionPlan {
  /** 相機能持續移動，按住才有意義 */
  hold: boolean;
  /** 點一下：相對移動一步，或持續移動一小段後停止 */
  tap: "relative" | "pulse";
  /** 變焦只有持續移動可靠，有的話一律用它 */
  zoomTap: "relative" | "pulse";
}

/** 相機能力加上偏好，決定這台怎麼動；偏好要求相機做不到的方式時忽略偏好 */
export function planMotion(caps: { continuous: boolean; relative: boolean }, mode: PtzMode): MotionPlan | null {
  if (!caps.continuous && !caps.relative) return null;
  const hold = caps.continuous && !(mode === "relative" && caps.relative);
  const relativeOk = caps.relative && !(mode === "continuous" && caps.continuous);
  return { hold, tap: relativeOk ? "relative" : "pulse", zoomTap: caps.continuous ? "pulse" : "relative" };
}

export interface DriverSnapshot {
  /** 目前按著的來源，形式是「p:left」（指標）或「k:left」（鍵盤） */
  held: readonly string[];
  /** 鏡頭正在動，或剛送出一步 */
  moving: boolean;
  error: string | null;
}

export interface DriverOptions {
  transport: Transport;
  clock: Clock;
  plan: MotionPlan;
  onChange: (s: DriverSnapshot) => void;
  /** 按住超過這麼久才算按住，之前放開是點一下 */
  holdMs?: number;
  /** 按住期間重送 move 的間隔；後端 1.5 秒沒收到就自動停止 */
  repeatMs?: number;
  /** 持續移動型的點一下要動多久 */
  pulseMs?: number;
  /** 一步之後多久內仍算移動中 */
  stepSettleMs?: number;
  errorMs?: number;
}

type Phase = "idle" | "pending" | "holding" | "pulsing";

const ZERO: Vec = { pan: 0, tilt: 0, zoom: 0 };
const clamp = (n: number) => Math.max(-1, Math.min(1, n));
const sum = (vs: Iterable<Vec>): Vec => {
  const v = { ...ZERO };
  for (const x of vs) {
    v.pan += x.pan;
    v.tilt += x.tilt;
    v.zoom += x.zoom;
  }
  return { pan: clamp(v.pan), tilt: clamp(v.tilt), zoom: clamp(v.zoom) };
};

export interface PtzDriver {
  /** 按下。同一個來源重複按（例如鍵盤自動重複）會被忽略 */
  press(source: string, vec: Vec): void;
  /** 正常放開：很快放開是點一下，否則停止 */
  release(source: string): void;
  /** 被打斷（指標離開或取消、視窗失焦、分頁隱藏、離開頁面）：只停止，不當成點一下。不給來源就是全部 */
  cancel(source?: string): void;
  /** 明確的停止鈕：不管狀態一律送 stop */
  halt(): void;
  snapshot(): DriverSnapshot;
}

/**
 * 方向控制的狀態機。idle → pending（按下，還沒決定是點還是按住）→ holding（持續移動，每 repeatMs 重送）
 * 或在 holdMs 內放開成為點一下（idle，或 pulsing 一小段後停止）。
 * 凡是持續移動的路徑都有一條回到 idle 並送 stop 的出口：放開、cancel、halt、任何一次 move 失敗。
 */
export function createPtzDriver(opts: DriverOptions): PtzDriver {
  const { transport, clock, plan, onChange } = opts;
  const holdMs = opts.holdMs ?? 250;
  const repeatMs = opts.repeatMs ?? 500;
  const pulseMs = opts.pulseMs ?? 200;
  const stepSettleMs = opts.stepSettleMs ?? 450;
  const errorMs = opts.errorMs ?? 6000;

  let phase: Phase = "idle";
  const held = new Map<string, Vec>();
  let pendingVec: Vec = ZERO;
  let holdTimer: unknown = null;
  let repeatTimer: unknown = null;
  let pulseTimer: unknown = null;
  let settleTimer: unknown = null;
  let errorTimer: unknown = null;
  let stepping = false;
  let error: string | null = null;
  let epoch = 0;

  const snapshot = (): DriverSnapshot => ({
    held: [...held.keys()],
    moving: phase === "holding" || phase === "pulsing" || stepping,
    error,
  });
  const notify = () => onChange(snapshot());

  const clear = (id: unknown) => id !== null && clock.clearTimeout(id);
  const clearTimers = () => {
    clear(holdTimer);
    clear(repeatTimer);
    clear(pulseTimer);
    holdTimer = repeatTimer = pulseTimer = null;
  };

  const setError = (message: string | null) => {
    clear(errorTimer);
    errorTimer = null;
    error = message;
    if (message) {
      errorTimer = clock.setTimeout(() => {
        errorTimer = null;
        error = null;
        notify();
      }, errorMs);
    }
  };

  const sendStop = () => {
    epoch++;
    transport.stop().catch(() => {});
  };

  const fail = (e: unknown) => {
    const wasActive = phase !== "idle";
    clearTimers();
    held.clear();
    phase = "idle";
    stepping = false;
    clear(settleTimer);
    settleTimer = null;
    setError(e instanceof Error ? e.message : String(e));
    if (wasActive) sendStop();
    notify();
  };

  const sendMove = (kind: MoveKind, vec: Vec) => {
    const sentIn = epoch;
    transport.move(vec, kind).then(
      () => {
        // stop 比這次 move 先到相機的話，move 會把鏡頭又推動起來；沒有新的操作就補一次 stop
        if (kind !== "step" && sentIn !== epoch && phase === "idle") transport.stop().catch(() => {});
      },
      (e) => {
        if (kind === "step" || sentIn === epoch) fail(e);
        else setError(e instanceof Error ? e.message : String(e)), notify();
      },
    );
    if (kind === "step") {
      stepping = true;
      clear(settleTimer);
      settleTimer = clock.setTimeout(() => {
        settleTimer = null;
        stepping = false;
        notify();
      }, stepSettleMs);
    }
  };

  const scheduleRepeat = () => {
    clear(repeatTimer);
    repeatTimer = clock.setTimeout(() => {
      repeatTimer = null;
      if (phase !== "holding") return;
      sendMove("hold", sum(held.values()));
      scheduleRepeat();
    }, repeatMs);
  };

  const beginHold = () => {
    holdTimer = null;
    if (phase !== "pending") return;
    phase = "holding";
    sendMove("hold", sum(held.values()));
    scheduleRepeat();
    notify();
  };

  const endPulse = () => {
    clear(pulseTimer);
    pulseTimer = null;
    phase = "idle";
    sendStop();
  };

  const tap = (vec: Vec) => {
    const kind = vec.zoom !== 0 ? plan.zoomTap : plan.tap;
    if (kind === "relative") return sendMove("step", vec);
    phase = "pulsing";
    sendMove("pulse", vec);
    pulseTimer = clock.setTimeout(() => {
      pulseTimer = null;
      endPulse();
      notify();
    }, pulseMs);
  };

  const stopHolding = () => {
    clearTimers();
    phase = "idle";
    sendStop();
  };

  return {
    snapshot,
    press(source, vec) {
      if (held.has(source)) return;
      if (error) setError(null);
      if (phase === "pulsing") endPulse();
      held.set(source, vec);
      if (!plan.hold) {
        sendMove("step", vec);
      } else if (phase === "idle") {
        phase = "pending";
        pendingVec = vec;
        holdTimer = clock.setTimeout(beginHold, holdMs);
      } else if (phase === "pending") {
        pendingVec = sum([pendingVec, vec]);
      } else {
        sendMove("hold", sum(held.values()));
        scheduleRepeat();
      }
      notify();
    },
    release(source) {
      if (!held.delete(source)) return;
      if (plan.hold) {
        if (phase === "pending" && held.size === 0) {
          clear(holdTimer);
          holdTimer = null;
          phase = "idle";
          tap(pendingVec);
        } else if (phase === "holding") {
          if (held.size === 0) stopHolding();
          else {
            sendMove("hold", sum(held.values()));
            scheduleRepeat();
          }
        }
      }
      notify();
    },
    cancel(source) {
      if (source !== undefined && !held.has(source)) return;
      if (source === undefined) held.clear();
      else held.delete(source);
      if (plan.hold && held.size === 0) {
        if (phase === "pending") {
          clearTimers();
          phase = "idle";
        } else if (phase === "holding") stopHolding();
        else if (phase === "pulsing") endPulse();
      } else if (phase === "holding") {
        sendMove("hold", sum(held.values()));
        scheduleRepeat();
      }
      notify();
    },
    halt() {
      clearTimers();
      held.clear();
      phase = "idle";
      stepping = false;
      clear(settleTimer);
      settleTimer = null;
      sendStop();
      notify();
    },
  };
}
