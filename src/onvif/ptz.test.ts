import { afterEach, describe, expect, test } from "bun:test";
import { OnvifClient } from "./client.ts";
import { OnvifError } from "./errors.ts";
import { FakeOnvif } from "./fake-onvif.ts";
import {
  clampSpeed,
  continuousMove,
  getPresets,
  gotoPreset,
  PtzController,
  relativeMove,
  removePreset,
  SafeStopWatchdog,
  setPreset,
  stop,
  type Timer,
} from "./ptz.ts";
import { child, parseXml, path } from "./xml.ts";

class FakeTimer implements Timer {
  now = 0;
  private tasks: { id: number; at: number; fn: () => void }[] = [];
  private nextId = 1;
  set(fn: () => void, ms: number) {
    const id = this.nextId++;
    this.tasks.push({ id, at: this.now + ms, fn });
    return id;
  }
  clear(handle: unknown) {
    this.tasks = this.tasks.filter((t) => t.id !== handle);
  }
  advance(ms: number) {
    this.now += ms;
    for (const t of this.tasks.filter((t) => t.at <= this.now)) {
      this.clear(t.id);
      t.fn();
    }
  }
}

let fake: FakeOnvif | null = null;
afterEach(async () => {
  await fake?.stop();
  fake = null;
});

async function setup(opts: ConstructorParameters<typeof FakeOnvif>[0] = {}) {
  fake = await new FakeOnvif(opts).start();
  return { f: fake, client: new OnvifClient(fake.endpoint) };
}

/** 最後一個指定動作的 Body 內容 */
function lastBody(f: FakeOnvif, action: string) {
  const req = [...f.requests].reverse().find((r) => r.action === action);
  if (!req) throw new Error(`沒有收到 ${action}`);
  return path(parseXml(req.body), "Body", action)!;
}

const count = (f: FakeOnvif, action: string) => f.actions().filter((a) => a === action).length;

async function waitFor(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await Bun.sleep(10);
  expect(cond()).toBe(true);
}

describe("PTZ 指令", () => {
  test("速度限制在 0.1 到 1.0", () => {
    expect(clampSpeed(0)).toBe(0.1);
    expect(clampSpeed(5)).toBe(1);
    expect(clampSpeed(0.5)).toBe(0.5);
    expect(clampSpeed(Number.NaN)).toBe(1);
  });

  test("ContinuousMove 送出方向乘上速度，沒有變焦時不送 Zoom", async () => {
    const { f, client } = await setup();
    await continuousMove(client, { pan: -1, tilt: 0.5, zoom: 0 }, 0.4);
    const body = lastBody(f, "ContinuousMove");
    expect(child(body, "ProfileToken")?.text).toBe("profile_1");
    expect(path(body, "Velocity", "PanTilt")?.attrs).toEqual({ x: "-0.4", y: "0.2" });
    expect(path(body, "Velocity", "Zoom")).toBeUndefined();
  });

  test("RelativeMove 送出位移與速度", async () => {
    const { f, client } = await setup();
    await relativeMove(client, { pan: 0, tilt: -1, zoom: 0 }, 2, 0.2);
    const body = lastBody(f, "RelativeMove");
    expect(path(body, "Translation", "PanTilt")?.attrs).toEqual({ x: "0", y: "-0.2" });
    expect(path(body, "Speed", "PanTilt")?.attrs).toEqual({ x: "1", y: "1" });
  });

  test("Stop 只帶 ProfileToken，停止所有軸", async () => {
    const { f, client } = await setup();
    await stop(client);
    expect(lastBody(f, "Stop").children.map((c) => c.local)).toEqual(["ProfileToken"]);
  });

  test("預置點新增、列出、前往、刪除；名稱裡的特殊字元正確跳脫", async () => {
    const { f, client } = await setup();
    const name = `門口 & <車道> "A"`;
    const token = await setPreset(client, name);
    expect(child(lastBody(f, "SetPreset"), "PresetName")?.text).toBe(name);
    expect(await getPresets(client)).toEqual([{ token, name }]);
    await setPreset(client, "改名", token);
    expect(await getPresets(client)).toEqual([{ token, name: "改名" }]);
    await gotoPreset(client, token, 0.05);
    expect(child(lastBody(f, "GotoPreset"), "PresetToken")?.text).toBe(token);
    expect(path(lastBody(f, "GotoPreset"), "Speed", "PanTilt")?.attrs.x).toBe("0.1");
    await removePreset(client, token);
    expect(await getPresets(client)).toEqual([]);
  });

  test("沒有 PTZ 的相機回報 protocol 錯誤，不送出請求", async () => {
    const { f, client } = await setup({ without: ["PTZ"] });
    expect((await client.capabilities()).ptz).toBeNull();
    const err = await continuousMove(client, { pan: 1, tilt: 0, zoom: 0 }, 1).catch((e) => e);
    expect(err).toBeInstanceOf(OnvifError);
    expect(err.kind).toBe("protocol");
    expect(count(f, "ContinuousMove")).toBe(0);
  });
});

describe("SafeStopWatchdog", () => {
  test("最後一次移動後 1.5 秒才觸發，期間的移動會重新計時", () => {
    const timer = new FakeTimer();
    let fired = 0;
    const w = new SafeStopWatchdog(1500, timer, () => fired++);
    w.moved();
    timer.advance(1000);
    w.moved();
    timer.advance(1499);
    expect(fired).toBe(0);
    expect(w.state).toBe("armed");
    timer.advance(1);
    expect(fired).toBe(1);
    expect(w.state).toBe("idle");
    timer.advance(10_000);
    expect(fired).toBe(1);
  });

  test("停止後不再觸發", () => {
    const timer = new FakeTimer();
    let fired = 0;
    const w = new SafeStopWatchdog(1500, timer, () => fired++);
    w.moved();
    w.disarm();
    timer.advance(5_000);
    expect(fired).toBe(0);
  });
});

describe("PtzController", () => {
  test("持續移動後 1.5 秒沒有新指令就自動 Stop", async () => {
    const { f, client } = await setup();
    const timer = new FakeTimer();
    const ptz = new PtzController(client, { timer });
    expect(await ptz.move({ pan: 1, tilt: 0, zoom: 0 }, 0.5)).toBe("continuous");
    timer.advance(500);
    await ptz.move({ pan: 1, tilt: 0, zoom: 0 }, 0.5);
    timer.advance(1499);
    expect(count(f, "Stop")).toBe(0);
    timer.advance(1);
    await waitFor(() => count(f, "Stop") === 1);
    expect(ptz.safeStopState).toBe("idle");
  });

  test("手動 Stop 會取消安全停止，不會重複送 Stop", async () => {
    const { f, client } = await setup();
    const timer = new FakeTimer();
    const ptz = new PtzController(client, { timer });
    await ptz.move({ pan: 0, tilt: 1, zoom: 0 }, 1);
    await ptz.stop();
    timer.advance(5_000);
    await Bun.sleep(30);
    expect(count(f, "Stop")).toBe(1);
  });

  test("自動模式：持續移動回 Fault 就改用相對移動並記住", async () => {
    const { f, client } = await setup({ continuousUnsupported: true });
    const timer = new FakeTimer();
    const ptz = new PtzController(client, { timer });
    expect(await ptz.move({ pan: 1, tilt: 0, zoom: 0 }, 0.5)).toBe("relative");
    expect(ptz.learnedMode).toBe("relative");
    expect(await ptz.move({ pan: 1, tilt: 0, zoom: 0 }, 0.5)).toBe("relative");
    expect(count(f, "ContinuousMove")).toBe(1);
    expect(count(f, "RelativeMove")).toBe(2);
    expect(ptz.safeStopState).toBe("idle");
  });

  test("手動指定持續移動時，相機回錯就直接回報，不改用相對移動", async () => {
    const { f, client } = await setup({ continuousUnsupported: true });
    const ptz = new PtzController(client, { mode: "continuous", timer: new FakeTimer() });
    const err = await ptz.move({ pan: 1, tilt: 0, zoom: 0 }, 0.5).catch((e) => e);
    expect(err).toMatchObject({ kind: "fault", action: "ContinuousMove" });
    expect(count(f, "RelativeMove")).toBe(0);
  });

  test("逾時之類的錯誤不會被當成不支援持續移動", async () => {
    const { f, client } = await setup();
    await client.capabilities();
    f.delays.set("ContinuousMove", 500);
    const ptz = new PtzController(new OnvifClient(f.endpoint, { timeoutMs: 200 }), { timer: new FakeTimer() });
    const err = await ptz.move({ pan: 1, tilt: 0, zoom: 0 }, 0.5).catch((e) => e);
    expect(err.kind).toBe("timeout");
    expect(ptz.learnedMode).toBeNull();
    expect(count(f, "RelativeMove")).toBe(0);
  });

  test("安全停止送 Stop 失敗時交給 onError", async () => {
    const { f, client } = await setup();
    const timer = new FakeTimer();
    const errors: unknown[] = [];
    const ptz = new PtzController(client, { timer, onError: (e) => errors.push(e) });
    await ptz.move({ pan: 1, tilt: 0, zoom: 0 }, 0.5);
    f.faults.set("Stop", { code: "Receiver", subcode: "Busy", reason: "busy" });
    timer.advance(1500);
    await waitFor(() => errors.length === 1);
    expect(errors[0]).toMatchObject({ kind: "fault", action: "Stop" });
  });
});
