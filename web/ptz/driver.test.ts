import { describe, expect, test } from "bun:test";
import { createPtzDriver, planMotion, type Clock, type DriverSnapshot, type MoveKind, type MotionPlan, type Vec } from "./driver.ts";

class FakeClock implements Clock {
  now = 0;
  private next = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number) {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(id: unknown) {
    this.timers.delete(id as number);
  }
  get pending() {
    return this.timers.size;
  }
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      let nextId = -1;
      let nextAt = Infinity;
      for (const [id, t] of this.timers) if (t.at <= end && t.at < nextAt) [nextId, nextAt] = [id, t.at];
      if (nextId < 0) break;
      const t = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.now = t.at;
      t.fn();
    }
    this.now = end;
  }
}

type Call = { at: number; type: "move"; kind: MoveKind; vec: Vec } | { at: number; type: "stop" };

function setup(plan: MotionPlan, behavior: { move?: () => Promise<unknown>; stop?: () => Promise<unknown> } = {}) {
  const clock = new FakeClock();
  const calls: Call[] = [];
  const snaps: DriverSnapshot[] = [];
  const driver = createPtzDriver({
    clock,
    plan,
    transport: {
      move: (vec, kind) => {
        calls.push({ at: clock.now, type: "move", kind, vec });
        return behavior.move ? behavior.move() : Promise.resolve({ mode: "continuous" });
      },
      stop: () => {
        calls.push({ at: clock.now, type: "stop" });
        return behavior.stop ? behavior.stop() : Promise.resolve();
      },
    },
    onChange: (s) => snaps.push(s),
  });
  return { clock, calls, snaps, driver };
}

const FULL: MotionPlan = { hold: true, tap: "relative", zoomTap: "pulse" };
const CONTINUOUS_ONLY: MotionPlan = { hold: true, tap: "pulse", zoomTap: "pulse" };
const RELATIVE_ONLY: MotionPlan = { hold: false, tap: "relative", zoomTap: "relative" };
const LEFT: Vec = { pan: -1, tilt: 0, zoom: 0 };
const UP: Vec = { pan: 0, tilt: 1, zoom: 0 };
const ZOOM_IN: Vec = { pan: 0, tilt: 0, zoom: 1 };
const kinds = (calls: Call[]) => calls.map((c) => (c.type === "stop" ? "stop" : c.kind));
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("planMotion", () => {
  test("拿能力與偏好決定按住與點一下的行為", () => {
    expect(planMotion({ continuous: true, relative: true }, "auto")).toEqual({ hold: true, tap: "relative", zoomTap: "pulse" });
    expect(planMotion({ continuous: true, relative: true }, "relative")).toEqual({ hold: false, tap: "relative", zoomTap: "pulse" });
    expect(planMotion({ continuous: true, relative: true }, "continuous")).toEqual({ hold: true, tap: "pulse", zoomTap: "pulse" });
    expect(planMotion({ continuous: false, relative: true }, "auto")).toEqual({ hold: false, tap: "relative", zoomTap: "relative" });
    expect(planMotion({ continuous: true, relative: false }, "relative")).toEqual({ hold: true, tap: "pulse", zoomTap: "pulse" });
    expect(planMotion({ continuous: false, relative: false }, "auto")).toBeNull();
  });
});

describe("點一下", () => {
  test("有相對移動：放開時送一次 step，不送 stop", () => {
    const { clock, calls, driver } = setup(FULL);
    driver.press("p:left", LEFT);
    clock.advance(100);
    expect(calls).toEqual([]);
    driver.release("p:left");
    clock.advance(5000);
    expect(kinds(calls)).toEqual(["step"]);
    expect(driver.snapshot().held).toEqual([]);
  });

  test("只有持續移動：動一小段再 stop", () => {
    const { clock, calls, driver } = setup(CONTINUOUS_ONLY);
    driver.press("p:left", LEFT);
    clock.advance(80);
    driver.release("p:left");
    expect(kinds(calls)).toEqual(["pulse"]);
    expect(driver.snapshot().moving).toBe(true);
    clock.advance(200);
    expect(kinds(calls)).toEqual(["pulse", "stop"]);
    expect(driver.snapshot().moving).toBe(false);
  });

  test("變焦點一下用持續移動一小段，不用相對移動", () => {
    const { clock, calls, driver } = setup(FULL);
    driver.press("p:zoomIn", ZOOM_IN);
    driver.release("p:zoomIn");
    clock.advance(300);
    expect(kinds(calls)).toEqual(["pulse", "stop"]);
  });

  test("一小段還沒結束又按下：先停掉上一段", () => {
    const { clock, calls, driver } = setup(CONTINUOUS_ONLY);
    driver.press("p:left", LEFT);
    driver.release("p:left");
    clock.advance(50);
    driver.press("p:up", UP);
    expect(kinds(calls)).toEqual(["pulse", "stop"]);
    clock.advance(1000);
    expect(kinds(calls)).toEqual(["pulse", "stop", "hold", "hold"]);
    driver.release("p:up");
    expect(kinds(calls).at(-1)).toBe("stop");
  });
});

describe("按住", () => {
  test("超過 250 ms 開始持續移動，每 500 ms 重送，放開立刻 stop 且不再重送", () => {
    const { clock, calls, driver } = setup(FULL);
    driver.press("p:left", LEFT);
    clock.advance(249);
    expect(calls).toEqual([]);
    clock.advance(1);
    expect(calls.map((c) => c.at)).toEqual([250]);
    clock.advance(1500);
    expect(calls.filter((c) => c.type === "move").map((c) => c.at)).toEqual([250, 750, 1250, 1750]);
    clock.advance(100);
    driver.release("p:left");
    expect(kinds(calls).at(-1)).toBe("stop");
    expect(calls.at(-1)!.at).toBe(1850);
    const count = calls.length;
    clock.advance(10_000);
    expect(calls.length).toBe(count);
    expect(clock.pending).toBe(0);
    expect(driver.snapshot()).toEqual({ held: [], moving: false, error: null });
  });

  test("鍵盤自動重複的 press 被忽略", () => {
    const { clock, calls, driver } = setup(FULL);
    for (let i = 0; i < 15; i++) {
      driver.press("k:left", LEFT);
      clock.advance(40);
    }
    expect(kinds(calls)).toEqual(["hold"]);
  });

  test("斜向：兩個方向合成一個向量，放掉一個改成另一個，全放開才 stop", () => {
    const { clock, calls, driver } = setup(FULL);
    driver.press("k:left", LEFT);
    clock.advance(300);
    driver.press("k:up", UP);
    expect(calls.at(-1)).toMatchObject({ type: "move", vec: { pan: -1, tilt: 1 } });
    driver.release("k:left");
    expect(calls.at(-1)).toMatchObject({ type: "move", vec: { pan: 0, tilt: 1 } });
    expect(kinds(calls)).not.toContain("stop");
    driver.release("k:up");
    expect(calls.at(-1)).toEqual({ at: 300, type: "stop" });
  });

  test("按住中被打斷（指標離開、失焦、分頁隱藏等都走 cancel）：立刻 stop，不當成點一下", () => {
    const { clock, calls, driver } = setup(FULL);
    driver.press("p:left", LEFT);
    clock.advance(800);
    driver.cancel();
    expect(kinds(calls)).toEqual(["hold", "hold", "stop"]);
    driver.release("p:left");
    clock.advance(5000);
    expect(kinds(calls)).toEqual(["hold", "hold", "stop"]);
  });

  test("還沒決定是點還是按住就被打斷：什麼都不送", () => {
    const { clock, calls, driver } = setup(FULL);
    driver.press("p:left", LEFT);
    clock.advance(100);
    driver.cancel("p:left");
    clock.advance(5000);
    expect(calls).toEqual([]);
    expect(clock.pending).toBe(0);
  });

  test("halt：不管狀態一律送 stop", () => {
    const { calls, driver } = setup(FULL);
    driver.halt();
    expect(kinds(calls)).toEqual(["stop"]);
  });

  test("沒有按住時 cancel 什麼都不做", () => {
    const { calls, driver } = setup(FULL);
    driver.cancel();
    expect(calls).toEqual([]);
  });
});

describe("只有相對移動", () => {
  test("按下就走一步，按再久也不重送、不送 stop", () => {
    const { clock, calls, driver } = setup(RELATIVE_ONLY);
    driver.press("p:left", LEFT);
    expect(kinds(calls)).toEqual(["step"]);
    clock.advance(5000);
    driver.release("p:left");
    expect(kinds(calls)).toEqual(["step"]);
    expect(clock.pending).toBe(0);
  });

  test("按下的狀態維持到放開，移動中短暫顯示", () => {
    const { clock, driver } = setup(RELATIVE_ONLY);
    driver.press("p:left", LEFT);
    expect(driver.snapshot()).toMatchObject({ held: ["p:left"], moving: true });
    clock.advance(500);
    expect(driver.snapshot().moving).toBe(false);
    driver.release("p:left");
    expect(driver.snapshot().held).toEqual([]);
  });
});

describe("失敗", () => {
  test("按住時 move 失敗：回到 idle、停止重送、嘗試 stop、顯示中文訊息，不會卡在移動中", async () => {
    let n = 0;
    const { clock, calls, driver } = setup(FULL, { move: () => (++n === 2 ? Promise.reject(new Error("無法連線到伺服器")) : Promise.resolve({})) });
    driver.press("p:left", LEFT);
    clock.advance(800);
    await flush();
    expect(driver.snapshot()).toEqual({ held: [], moving: false, error: "無法連線到伺服器" });
    expect(kinds(calls)).toEqual(["hold", "hold", "stop"]);
    const count = calls.length;
    clock.advance(5000);
    expect(calls.length).toBe(count);
    driver.release("p:left");
    expect(calls.length).toBe(count);
  });

  test("第一次 move 就失敗也一樣", async () => {
    const { clock, calls, driver } = setup(FULL, { move: () => Promise.reject(new Error("相機拒絕了這個指令，請稍後再試")) });
    driver.press("p:left", LEFT);
    clock.advance(250);
    await flush();
    expect(driver.snapshot().error).toBe("相機拒絕了這個指令，請稍後再試");
    expect(driver.snapshot().moving).toBe(false);
    expect(kinds(calls)).toEqual(["hold", "stop"]);
  });

  test("stop 自己失敗不會丟出未處理的錯誤", async () => {
    const { clock, driver } = setup(FULL, { stop: () => Promise.reject(new Error("x")) });
    driver.press("p:left", LEFT);
    clock.advance(300);
    driver.release("p:left");
    await flush();
    expect(driver.snapshot().moving).toBe(false);
  });

  test("step 失敗：顯示訊息，不送 stop", async () => {
    const { calls, driver } = setup(RELATIVE_ONLY, { move: () => Promise.reject(new Error("這台相機沒有變焦功能")) });
    driver.press("p:left", LEFT);
    await flush();
    expect(driver.snapshot().error).toBe("這台相機沒有變焦功能");
    expect(driver.snapshot().held).toEqual([]);
    expect(kinds(calls)).toEqual(["step"]);
  });

  test("錯誤訊息過一陣子或下一次按下就消失", async () => {
    const { clock, driver } = setup(RELATIVE_ONLY, { move: () => Promise.reject(new Error("壞了")) });
    driver.press("p:left", LEFT);
    await flush();
    expect(driver.snapshot().error).toBe("壞了");
    clock.advance(6000);
    expect(driver.snapshot().error).toBeNull();
    driver.press("p:up", UP);
    expect(driver.snapshot().error).toBeNull();
  });

  test("stop 比 move 先到：move 回應時補送一次 stop", async () => {
    let resolveMove!: () => void;
    const { clock, calls, driver } = setup(FULL, { move: () => new Promise<void>((r) => (resolveMove = r)) });
    driver.press("p:left", LEFT);
    clock.advance(260);
    driver.release("p:left");
    expect(kinds(calls)).toEqual(["hold", "stop"]);
    resolveMove();
    await flush();
    expect(kinds(calls)).toEqual(["hold", "stop", "stop"]);
  });

  test("補送 stop 不會誤停新的按住", async () => {
    const resolvers: (() => void)[] = [];
    const { clock, calls, driver } = setup(FULL, { move: () => new Promise<void>((r) => resolvers.push(r)) });
    driver.press("p:left", LEFT);
    clock.advance(260);
    driver.release("p:left");
    driver.press("p:left", LEFT);
    clock.advance(260);
    resolvers[0]!();
    await flush();
    expect(kinds(calls)).toEqual(["hold", "stop", "hold"]);
  });
});

describe("任何順序的操作都不會放開了還在轉", () => {
  test("隨機操作序列：結束後一定回到 idle，最後一個指令是 stop，且不再有計時器", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const sources: [string, Vec][] = [["p:left", LEFT], ["p:up", UP], ["k:left", LEFT], ["k:zoomIn", ZOOM_IN]];
    for (const plan of [FULL, CONTINUOUS_ONLY, RELATIVE_ONLY]) {
      for (let run = 0; run < 300; run++) {
        const { clock, calls, driver } = setup(plan);
        for (let i = 0; i < 30; i++) {
          const [src, vec] = sources[Math.floor(rand() * sources.length)]!;
          const r = rand();
          if (r < 0.4) driver.press(src, vec);
          else if (r < 0.7) driver.release(src);
          else if (r < 0.8) driver.cancel(src);
          else if (r < 0.85) driver.cancel();
          clock.advance(Math.floor(rand() * 700));
        }
        driver.cancel();
        clock.advance(10_000);
        expect(driver.snapshot()).toEqual({ held: [], moving: false, error: null });
        expect(clock.pending).toBe(0);
        const lastMove = calls.findLastIndex((c) => c.type === "move" && c.kind !== "step");
        if (lastMove >= 0) expect(calls.slice(lastMove).some((c) => c.type === "stop")).toBe(true);
        const count = calls.length;
        clock.advance(10_000);
        expect(calls.length).toBe(count);
      }
    }
  });
});
