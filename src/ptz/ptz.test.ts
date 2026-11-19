import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { PtzDto, PtzMoveResultDto, PtzPresetSavedDto, PtzPresetsDto } from "../api-types.ts";
import { createAuth } from "../auth/index.ts";
import { openDb } from "../db.ts";
import { buildDiagnostics } from "../diagnostics.ts";
import { parseCameraConfig } from "../http/parse.ts";
import { createRouter, type ServerLike } from "../http/router.ts";
import { FakeOnvif, type FakeOnvifOptions } from "../onvif/fake-onvif.ts";
import { createCameraStore } from "../stores/index.ts";
import { defaultSettings, type Camera, type CameraConfig, type CameraId, type CameraStore, type OnvifEndpoint } from "../types.ts";
import { onvifEndpointOf, orientMove, ptzPrefsOf } from "./config.ts";
import { createPtzHub, type PtzHub } from "./hub.ts";
import { probeOnvif } from "./probe.ts";
import { ptzRoutes } from "./routes.ts";

setDefaultTimeout(15_000);

const IDLE_MS = 300;
const sleep = (ms: number) => Bun.sleep(ms);
const count = (f: FakeOnvif, action: string) => f.actions().filter((a) => a === action).length;

function rtspCamera(name: string, onvif?: OnvifEndpoint, ptz?: CameraConfig["ptz"]): CameraConfig {
  return {
    name,
    enabled: true,
    connection: { type: "rtsp", mainUrl: "rtsp://10.0.0.5/main", transport: "tcp", ...(onvif ? { onvif } : {}) },
    record: { enabled: false, audio: false, direct: false },
    ...(ptz ? { ptz } : {}),
  };
}

const fakes: FakeOnvif[] = [];
async function startFake(opts: FakeOnvifOptions = {}) {
  const f = await new FakeOnvif(opts).start();
  fakes.push(f);
  return f;
}

let cameras: CameraStore;
let hub: PtzHub;
let router: ReturnType<typeof createRouter>;
let admin: Record<string, string>;
let user: Record<string, string>;
let unsubscribe: () => void;

function req(path: string, init: { method?: string; json?: unknown; as?: Record<string, string>; raw?: string } = {}) {
  const headers = new Headers(init.as);
  let body: string | undefined;
  if (init.json !== undefined) body = JSON.stringify(init.json);
  if (init.raw !== undefined) body = init.raw;
  if (body !== undefined) headers.set("content-type", "application/json");
  const server: ServerLike = { requestIP: () => ({ address: "127.0.0.1" }) };
  return router(new Request(`http://nvr.local${path}`, { method: init.method ?? "GET", headers, body }), server);
}

const ptzPath = (c: Camera) => `/api/cameras/${c.id}/ptz`;
const addCamera = (config: CameraConfig) => cameras.create(config);
const onFake = (f: FakeOnvif, name = "cam", ptz?: CameraConfig["ptz"]) => addCamera(rtspCamera(name, f.endpoint, ptz));

async function boot(hubOpts: { idleStopMs?: number; timeoutMs?: number } = {}) {
  const db = openDb(":memory:");
  const auth = createAuth({ db });
  cameras = createCameraStore(db);
  hub = createPtzHub({ cameras, idleStopMs: hubOpts.idleStopMs ?? IDLE_MS, timeoutMs: hubOpts.timeoutMs });
  unsubscribe = cameras.subscribe((list) => hub.reconcile(list));
  router = createRouter(ptzRoutes({ hub }), auth);
  const client = { ip: "127.0.0.1", userAgent: "test" };
  const cookie = (token: string) => ({ cookie: auth.sessionCookie(token, false).split(";")[0]! });
  admin = cookie((await auth.setup("root", "password1", client)).sessionToken);
  await auth.createUser("bob", "password1", "user");
  user = cookie((await auth.login("bob", "password1", client)).sessionToken);
}

beforeEach(() => boot());
afterEach(async () => {
  unsubscribe();
  await hub.dispose();
  await Promise.all(fakes.splice(0).map((f) => f.stop()));
});

describe("權限", () => {
  test("沒登入一律 401", async () => {
    const f = await startFake();
    const c = onFake(f);
    expect((await req(ptzPath(c))).status).toBe(401);
    expect((await req(ptzPath(c), { method: "POST", json: { action: "stop" } })).status).toBe(401);
    expect((await req(`${ptzPath(c)}/presets`, { method: "POST", json: { name: "a" } })).status).toBe(401);
    expect((await req(`${ptzPath(c)}/presets`, { method: "DELETE", json: { token: "1" } })).status).toBe(401);
    expect(f.requests).toHaveLength(0);
  });

  test("一般使用者能看與操作，不能儲存或刪除預置點", async () => {
    const f = await startFake();
    const c = onFake(f);
    expect((await req(ptzPath(c), { as: user })).status).toBe(200);
    expect((await req(ptzPath(c), { method: "POST", as: user, json: { action: "move", pan: 1 } })).status).toBe(200);
    expect((await req(ptzPath(c), { method: "POST", as: user, json: { action: "stop" } })).status).toBe(204);
    const save = await req(`${ptzPath(c)}/presets`, { method: "POST", as: user, json: { name: "a" } });
    expect(save.status).toBe(403);
    expect((await req(`${ptzPath(c)}/presets`, { method: "DELETE", as: user, json: { token: "1" } })).status).toBe(403);
    expect(count(f, "SetPreset") + count(f, "RemovePreset")).toBe(0);
  });

  test("管理員可以儲存與刪除預置點", async () => {
    const f = await startFake();
    const c = onFake(f);
    const save = await req(`${ptzPath(c)}/presets`, { method: "POST", as: admin, json: { name: "a" } });
    expect(save.status).toBe(201);
    const { token } = (await save.json()) as PtzPresetSavedDto;
    expect((await req(`${ptzPath(c)}/presets`, { method: "DELETE", as: admin, json: { token } })).status).toBe(200);
  });
});

describe("輸入驗證", () => {
  const bad: [string, unknown][] = [
    ["不是物件", []],
    ["沒有 action", {}],
    ["未知的 action", { action: "dance" }],
    ["pan 超出範圍", { action: "move", pan: 1.5 }],
    ["tilt 不是數字", { action: "move", tilt: "up" }],
    ["zoom 超出範圍", { action: "move", zoom: -2 }],
    ["三軸都是 0", { action: "move", pan: 0, tilt: 0, zoom: 0 }],
    ["完全沒有方向", { action: "move" }],
    ["速度太小", { action: "move", pan: 1, speed: 0.05 }],
    ["速度太大", { action: "move", pan: 1, speed: 1.1 }],
    ["模式錯誤", { action: "move", pan: 1, mode: "fast" }],
    ["預置點沒有 token", { action: "preset" }],
    ["預置點速度超出範圍", { action: "preset", token: "1", speed: 2 }],
  ];
  for (const [name, json] of bad) {
    test(`move／preset：${name} 回 400，不送任何指令給相機`, async () => {
      const f = await startFake();
      const c = onFake(f);
      const res = await req(ptzPath(c), { method: "POST", as: user, json });
      expect(res.status).toBe(400);
      expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
      expect(f.requests).toHaveLength(0);
    });
  }

  test("不是 JSON 回 400，Content-Type 不對回 415", async () => {
    const f = await startFake();
    const c = onFake(f);
    expect((await req(ptzPath(c), { method: "POST", as: user, raw: "{oops" })).status).toBe(400);
    const wrongType = new Request(`http://nvr.local${ptzPath(c)}`, { method: "POST", headers: { ...user, "content-type": "text/plain" }, body: "{}" });
    expect((await router(wrongType, { requestIP: () => ({ address: "127.0.0.1" }) })).status).toBe(415);
  });

  test("預置點：名稱為空、太長、token 不是字串回 400", async () => {
    const f = await startFake();
    const c = onFake(f);
    const url = `${ptzPath(c)}/presets`;
    for (const json of [{}, { name: "  " }, { name: "x".repeat(65) }, { name: "a", token: 3 }]) {
      expect((await req(url, { method: "POST", as: admin, json })).status).toBe(400);
    }
    for (const json of [{}, { token: 1 }]) {
      expect((await req(url, { method: "DELETE", as: admin, json })).status).toBe(400);
    }
    expect((await req(url, { method: "DELETE", as: admin })).status).toBe(400);
    expect(f.requests).toHaveLength(0);
  });

  test("找不到攝影機回 404", async () => {
    expect((await req("/api/cameras/nope/ptz", { as: user })).status).toBe(404);
    expect((await req("/api/cameras/nope/ptz", { method: "POST", as: user, json: { action: "stop" } })).status).toBe(404);
  });
});

describe("能力與不支援", () => {
  test("回傳能力與預置點清單", async () => {
    const f = await startFake();
    f.presets.set("p1", "大門");
    const c = onFake(f);
    const dto = (await (await req(ptzPath(c), { as: user })).json()) as PtzDto;
    expect(dto).toEqual({
      supported: true,
      continuous: true,
      relative: true,
      zoom: false,
      maxPresets: 8,
      presets: [{ token: "p1", name: "大門" }],
      prefs: { mode: "auto", speed: 0.5, invertPan: false, invertTilt: false },
    });
  });

  test("沒有設定 ONVIF 的相機回「不支援」而不是錯誤，且不連線", async () => {
    const c = addCamera(rtspCamera("plain"));
    const res = await req(ptzPath(c), { as: user });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ supported: false, reason: "no-onvif" });
    const move = await req(ptzPath(c), { method: "POST", as: user, json: { action: "move", pan: 1 } });
    expect(move.status).toBe(409);
    expect(((await move.json()) as { error: string }).error).toContain("ONVIF");
  });

  test("相機沒有 PTZ 回「不支援」", async () => {
    const f = await startFake({ without: ["PTZ"] });
    const c = onFake(f);
    expect(await (await req(ptzPath(c), { as: user })).json()).toEqual({ supported: false, reason: "no-ptz" });
    const move = await req(ptzPath(c), { method: "POST", as: user, json: { action: "move", pan: 1 } });
    expect(move.status).toBe(409);
    expect(count(f, "ContinuousMove")).toBe(0);
  });

  test("舊資料沒有 ptz 欄位時用預設偏好", () => {
    const old = rtspCamera("old");
    expect(old.ptz).toBeUndefined();
    expect(ptzPrefsOf(old)).toEqual({ mode: "auto", speed: 0.5, invertPan: false, invertTilt: false });
    expect(ptzPrefsOf(rtspCamera("x", undefined, { mode: "relative", speed: 0.8 }))).toEqual({ mode: "relative", speed: 0.8, invertPan: false, invertTilt: false });
  });

  test("攝影機設定的 ptz 欄位選填，有填時驗證模式與速度", () => {
    const base = rtspCamera("x");
    expect(parseCameraConfig(base).ptz).toBeUndefined();
    expect(parseCameraConfig({ ...base, ptz: { mode: "relative", speed: 0.1 } }).ptz).toEqual({ mode: "relative", speed: 0.1, invertPan: false, invertTilt: false });
    expect(parseCameraConfig({ ...base, ptz: { mode: "auto", speed: 0.5, invertPan: true } }).ptz).toEqual({ mode: "auto", speed: 0.5, invertPan: true, invertTilt: false });
    for (const ptz of [{ mode: "fast", speed: 0.5 }, { mode: "auto", speed: 0.05 }, { mode: "auto", speed: 1.5 }, { mode: "auto" }, "auto", { mode: "auto", speed: 0.5, invertPan: "yes" }]) {
      expect(() => parseCameraConfig({ ...base, ptz })).toThrow();
    }
  });

  test("Tapo 的 ONVIF 位址由主機推導：port 2020、同帳密，host 的 RTSP 埠被忽略", () => {
    const tapo = (host: string) => onvifEndpointOf({ type: "tapo", host, username: "u", password: "p" });
    expect(tapo("192.168.1.20")).toEqual({ host: "192.168.1.20", port: 2020, username: "u", password: "p" });
    expect(tapo("cam.local:8554")).toEqual({ host: "cam.local", port: 2020, username: "u", password: "p" });
    expect(tapo("[fe80::1]:8554")?.host).toBe("[fe80::1]");
    expect(onvifEndpointOf({ type: "rtsp", mainUrl: "rtsp://x/y", transport: "tcp" })).toBeNull();
  });
});

describe("移動與安全停止", () => {
  test("持續移動帶方向與速度，回報實際模式", async () => {
    const f = await startFake();
    const c = onFake(f);
    const res = await req(ptzPath(c), { method: "POST", as: user, json: { action: "move", pan: -1, tilt: 0.5, speed: 0.4 } });
    expect(await res.json()).toEqual({ mode: "continuous" } satisfies PtzMoveResultDto);
    const body = f.requests.find((r) => r.action === "ContinuousMove")!.body;
    expect(body).toContain('x="-0.4"');
    expect(body).toContain('y="0.2"');
  });

  test("反轉左右／上下時送給相機的方向相反，變焦不受影響", async () => {
    const f = await startFake();
    const c = onFake(f, "cam", { mode: "auto", speed: 0.5, invertPan: true, invertTilt: true });
    await req(ptzPath(c), { method: "POST", as: user, json: { action: "move", pan: -1, tilt: 1, speed: 0.4 } });
    const body = f.requests.find((r) => r.action === "ContinuousMove")!.body;
    expect(body).toContain('x="0.4"');
    expect(body).toContain('y="-0.4"');
    const prefs = { mode: "auto" as const, speed: 0.5, invertPan: true, invertTilt: false };
    expect(orientMove({ pan: 1, tilt: 1, zoom: 1 }, prefs)).toEqual({ pan: -1, tilt: 1, zoom: 1 });
  });

  test("沒指定速度時用攝影機的偏好速度", async () => {
    const f = await startFake();
    const c = onFake(f, "cam", { mode: "auto", speed: 0.8 });
    await req(ptzPath(c), { method: "POST", as: user, json: { action: "move", pan: 1 } });
    expect(f.requests.find((r) => r.action === "ContinuousMove")!.body).toContain('x="0.8"');
  });

  test("連續送移動時不停止；停止送出後約 1.5 秒自動 Stop", async () => {
    await hub.dispose();
    unsubscribe();
    const idle = 1500;
    await boot({ idleStopMs: idle });
    const f = await startFake();
    const c = onFake(f);
    const move = () => hub.move(c.id, { pan: 1, tilt: 0, zoom: 0 });
    let last = 0;
    for (let i = 0; i < 4; i++) {
      await move();
      last = Date.now();
      await sleep(500);
    }
    expect(count(f, "ContinuousMove")).toBe(4);
    expect(count(f, "Stop")).toBe(0);
    expect(hub.isBusy(c.id)).toBe(true);
    await sleep(idle - (Date.now() - last) - 300);
    expect(count(f, "Stop")).toBe(0);
    await sleep(600);
    expect(count(f, "Stop")).toBe(1);
    const elapsed = Date.now() - last;
    expect(elapsed).toBeGreaterThanOrEqual(idle);
    expect(elapsed).toBeLessThan(idle + 800);
    expect(hub.isBusy(c.id)).toBe(true);
  });

  test("手動停止立刻送 Stop 並取消安全停止，不會再多送一次", async () => {
    const f = await startFake();
    const c = onFake(f);
    await req(ptzPath(c), { method: "POST", as: user, json: { action: "move", pan: 1 } });
    expect((await req(ptzPath(c), { method: "POST", as: user, json: { action: "stop" } })).status).toBe(204);
    expect(count(f, "Stop")).toBe(1);
    await sleep(IDLE_MS + 200);
    expect(count(f, "Stop")).toBe(1);
  });

  test("相對移動不掛安全停止", async () => {
    const f = await startFake();
    const c = onFake(f, "cam", { mode: "relative", speed: 0.5 });
    const res = await req(ptzPath(c), { method: "POST", as: user, json: { action: "move", tilt: -1 } });
    expect(await res.json()).toEqual({ mode: "relative" });
    await sleep(IDLE_MS + 200);
    expect(count(f, "RelativeMove")).toBe(1);
    expect(count(f, "Stop")).toBe(0);
    expect(hub.isBusy(c.id)).toBe(true);
  });

  test("請求的 mode 蓋過攝影機偏好", async () => {
    const f = await startFake();
    const c = onFake(f, "cam", { mode: "continuous", speed: 0.5 });
    const res = await req(ptzPath(c), { method: "POST", as: user, json: { action: "move", pan: 1, mode: "relative" } });
    expect(await res.json()).toEqual({ mode: "relative" });
    expect(count(f, "ContinuousMove")).toBe(0);
  });

  test("自動模式：持續移動被相機拒絕就退回相對移動，並記住不再重試", async () => {
    const f = await startFake({ continuousUnsupported: true });
    const c = onFake(f);
    const move = () => req(ptzPath(c), { method: "POST", as: user, json: { action: "move", pan: 1 } });
    expect(await (await move()).json()).toEqual({ mode: "relative" });
    expect(await (await move()).json()).toEqual({ mode: "relative" });
    expect(count(f, "ContinuousMove")).toBe(1);
    expect(count(f, "RelativeMove")).toBe(2);
  });

  test("只改名稱不會重建控制器，學到的模式保留；改相機位址才重建", async () => {
    const f = await startFake({ continuousUnsupported: true });
    const c = onFake(f);
    const move = () => req(ptzPath(c), { method: "POST", as: user, json: { action: "move", pan: 1 } });
    await move();
    cameras.update(c.id, { ...c.config, name: "renamed" });
    await move();
    expect(count(f, "ContinuousMove")).toBe(1);
    const second = await startFake({ continuousUnsupported: true });
    cameras.update(c.id, rtspCamera("renamed", second.endpoint));
    await move();
    expect(count(second, "ContinuousMove")).toBe(1);
  });

  test("明確指定持續移動但相機拒絕時回 502，訊息是中文且不含英文原文", async () => {
    const f = await startFake({ continuousUnsupported: true });
    const c = onFake(f, "cam", { mode: "continuous", speed: 0.5 });
    const res = await req(ptzPath(c), { method: "POST", as: user, json: { action: "move", pan: 1 } });
    expect(res.status).toBe(502);
    const { error } = (await res.json()) as { error: string };
    expect(error).not.toContain("ContinuousMove");
    expect(error).not.toContain("not supported");
    expect(error).toMatch(/[一-鿿]/);
  });

  test("沒有變焦的相機收到 zoom 回 409；不支援的模式回 409", async () => {
    const f = await startFake({ continuousUnsupported: true });
    const c = onFake(f);
    const zoom = await req(ptzPath(c), { method: "POST", as: user, json: { action: "move", zoom: 1 } });
    expect(zoom.status).toBe(409);
    expect(count(f, "ContinuousMove") + count(f, "RelativeMove")).toBe(0);
  });
});

describe("預置點", () => {
  test("新增、覆寫、前往、刪除", async () => {
    const f = await startFake();
    const c = onFake(f);
    const url = `${ptzPath(c)}/presets`;
    const created = await req(url, { method: "POST", as: admin, json: { name: "  大門 " } });
    expect(created.status).toBe(201);
    const first = (await created.json()) as PtzPresetSavedDto;
    expect(first.presets).toEqual([{ token: first.token, name: "大門" }]);

    const renamed = await req(url, { method: "POST", as: admin, json: { name: "後門", token: first.token } });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as PtzPresetSavedDto).presets).toEqual([{ token: first.token, name: "後門" }]);

    const go = await req(ptzPath(c), { method: "POST", as: user, json: { action: "preset", token: first.token, speed: 0.3 } });
    expect(go.status).toBe(204);
    expect(f.requests.find((r) => r.action === "GotoPreset")!.body).toContain(first.token);

    const removed = await req(url, { method: "DELETE", as: admin, json: { token: first.token } });
    expect(((await removed.json()) as PtzPresetsDto).presets).toEqual([]);
    expect(f.presets.size).toBe(0);
  });

  test("超過上限回 409 並說明上限，覆寫不受上限影響", async () => {
    const f = await startFake();
    const c = onFake(f);
    const url = `${ptzPath(c)}/presets`;
    let token = "";
    for (let i = 1; i <= 8; i++) {
      const res = await req(url, { method: "POST", as: admin, json: { name: `點${i}` } });
      expect(res.status).toBe(201);
      token = ((await res.json()) as PtzPresetSavedDto).token;
    }
    const full = await req(url, { method: "POST", as: admin, json: { name: "第九個" } });
    expect(full.status).toBe(409);
    expect(((await full.json()) as { error: string }).error).toContain("8");
    expect(f.presets.size).toBe(8);
    expect((await req(url, { method: "POST", as: admin, json: { name: "改名", token } })).status).toBe(200);
  });

  test("覆寫或刪除不存在的預置點回 404，不送指令", async () => {
    const f = await startFake();
    const c = onFake(f);
    const url = `${ptzPath(c)}/presets`;
    expect((await req(url, { method: "POST", as: admin, json: { name: "a", token: "ghost" } })).status).toBe(404);
    expect((await req(url, { method: "DELETE", as: admin, json: { token: "ghost" } })).status).toBe(404);
    expect(count(f, "SetPreset") + count(f, "RemovePreset")).toBe(0);
  });

  test("沒有 PTZ 或沒有 ONVIF 時儲存預置點回 409", async () => {
    const c = addCamera(rtspCamera("plain"));
    expect((await req(`${ptzPath(c)}/presets`, { method: "POST", as: admin, json: { name: "a" } })).status).toBe(409);
  });
});

describe("錯誤對應", () => {
  async function errorOf(res: Response) {
    expect(res.ok).toBe(false);
    return { status: res.status, error: ((await res.json()) as { error: string }).error };
  }
  const readable = (error: string, secret: string) => {
    expect(error).toMatch(/[一-鿿]/);
    expect(error).not.toContain(secret);
    expect(error).not.toMatch(/Fault|Unauthorized|Sender|ECONN|fetch/);
  };

  test("連不上 → 503", async () => {
    const dead = await startFake();
    const endpoint = dead.endpoint;
    await dead.stop();
    const c = addCamera(rtspCamera("dead", endpoint));
    const e = await errorOf(await req(ptzPath(c), { as: user }));
    expect(e.status).toBe(503);
    readable(e.error, endpoint.password);
    const move = await errorOf(await req(ptzPath(c), { method: "POST", as: user, json: { action: "move", pan: 1 } }));
    expect(move.status).toBe(503);
  });

  test("逾時 → 504", async () => {
    await hub.dispose();
    unsubscribe();
    await boot({ timeoutMs: 300 });
    const f = await startFake();
    f.delays.set("GetProfiles", 1000);
    const c = onFake(f);
    const e = await errorOf(await req(ptzPath(c), { as: user }));
    expect(e.status).toBe(504);
    readable(e.error, f.endpoint.password);
  });

  test("帳密錯誤 → 502，不是 401（前端遇到 401 會登出網站）", async () => {
    const f = await startFake();
    const c = addCamera(rtspCamera("bad", { ...f.endpoint, password: "wrong-pass" }));
    const e = await errorOf(await req(ptzPath(c), { as: user }));
    expect(e.status).toBe(502);
    expect(e.error).toContain("帳號或密碼");
    readable(e.error, "wrong-pass");
  });

  test("相機回錯 → 502，不顯示相機的英文原文", async () => {
    const f = await startFake();
    f.faults.set("GetPresets", { subcode: "ActionNotSupported", reason: "Secret English Reason" });
    const c = onFake(f);
    const e = await errorOf(await req(ptzPath(c), { as: user }));
    expect(e.status).toBe(502);
    expect(e.error).not.toContain("Secret English Reason");
    readable(e.error, f.endpoint.password);
  });

  test("連線失敗後恢復，下一次請求就成功", async () => {
    const f = await startFake();
    f.faults.set("GetProfiles", { subcode: "ActionNotSupported", reason: "x" });
    const c = onFake(f);
    expect((await req(ptzPath(c), { as: user })).status).toBe(502);
    f.faults.clear();
    expect(((await (await req(ptzPath(c), { as: user })).json()) as PtzDto).supported).toBe(true);
  });
});

describe("控制器的生命週期", () => {
  test("移動中刪除攝影機會先送 Stop，之後不再有安全停止", async () => {
    const f = await startFake();
    const c = onFake(f);
    await hub.move(c.id, { pan: 1, tilt: 0, zoom: 0 });
    cameras.remove(c.id);
    await sleep(IDLE_MS + 300);
    expect(count(f, "Stop")).toBe(1);
    expect(hub.isBusy(c.id)).toBe(false);
  });

  test("移動中改了相機位址，舊的相機收到 Stop", async () => {
    const f = await startFake();
    const c = onFake(f);
    await hub.move(c.id, { pan: 1, tilt: 0, zoom: 0 });
    const other = await startFake();
    cameras.update(c.id, rtspCamera("cam", other.endpoint));
    await sleep(IDLE_MS + 300);
    expect(count(f, "Stop")).toBe(1);
    await hub.move(c.id, { pan: 1, tilt: 0, zoom: 0 });
    expect(count(other, "ContinuousMove")).toBe(1);
  });

  test("相機改成沒有 ONVIF 後不再連線", async () => {
    const f = await startFake();
    const c = onFake(f);
    await hub.info(c.id);
    cameras.update(c.id, rtspCamera("cam"));
    expect(await hub.info(c.id)).toEqual({ supported: false, reason: "no-onvif" });
  });

  test("主程序關閉時釋放：移動中的送出 Stop，沒移動的不送", async () => {
    const moving = await startFake();
    const idle = await startFake();
    const a = onFake(moving, "a");
    const b = onFake(idle, "b");
    await hub.move(a.id, { pan: 1, tilt: 0, zoom: 0 });
    await hub.info(b.id);
    await hub.dispose();
    expect(count(moving, "Stop")).toBe(1);
    expect(count(idle, "Stop")).toBe(0);
    await sleep(IDLE_MS + 300);
    expect(count(moving, "Stop")).toBe(1);
  });
});

describe("移動狀態查詢", () => {
  test("持續移動中與停止後都是忙碌，各相機互不影響", async () => {
    const f = await startFake();
    const a = onFake(f, "a");
    const b = onFake(f, "b");
    expect(hub.isBusy(a.id)).toBe(false);
    await hub.move(a.id, { pan: 1, tilt: 0, zoom: 0 });
    expect(hub.isBusy(a.id)).toBe(true);
    expect(hub.isBusy(b.id)).toBe(false);
    await hub.stop(a.id);
    expect(hub.isBusy(a.id)).toBe(true);
  });

  test("前往預置點也算移動；失敗的指令不算", async () => {
    const f = await startFake();
    const c = onFake(f);
    await hub.gotoPreset(c.id, "1");
    expect(hub.isBusy(c.id)).toBe(true);
    const g = await startFake({ without: ["PTZ"] });
    const d = onFake(g, "d");
    await hub.move(d.id, { pan: 1, tilt: 0, zoom: 0 }).catch(() => {});
    expect(hub.isBusy(d.id)).toBe(false);
  });
});

describe("測試連線的 ONVIF 結果", () => {
  const conn = (onvif?: OnvifEndpoint) => rtspCamera("x", onvif).connection;

  test("沒填 ONVIF → unconfigured", async () => {
    expect(await probeOnvif(conn())).toEqual({ state: "unconfigured" });
  });

  test("有 PTZ → available，含變焦與預置點上限", async () => {
    const f = await startFake();
    expect(await probeOnvif(conn(f.endpoint))).toEqual({ state: "available", ptz: true, zoom: false, maxPresets: 8 });
  });

  test("ONVIF 可用但沒有 PTZ", async () => {
    const f = await startFake({ without: ["PTZ"] });
    expect(await probeOnvif(conn(f.endpoint))).toEqual({ state: "available", ptz: false, zoom: false, maxPresets: null });
  });

  test("連不上、帳密錯誤、逾時都是 unavailable 而不是丟錯，訊息為中文", async () => {
    const f = await startFake();
    const wrong = await probeOnvif(conn({ ...f.endpoint, password: "nope-pass" }));
    expect(wrong).toMatchObject({ state: "unavailable", kind: "auth" });
    const dead = await startFake();
    const endpoint = dead.endpoint;
    await dead.stop();
    const down = await probeOnvif(conn(endpoint));
    expect(down).toMatchObject({ state: "unavailable", kind: "unreachable" });
    const slow = await startFake();
    slow.delays.set("GetProfiles", 2000);
    const timeout = await probeOnvif(conn(slow.endpoint), { timeoutMs: 300 });
    expect(timeout).toMatchObject({ state: "unavailable", kind: "timeout" });
    for (const r of [wrong, down, timeout]) {
      if (r.state !== "unavailable") throw new Error("unreachable");
      expect(r.message).toMatch(/[一-鿿]/);
      expect(r.message).not.toContain("nope-pass");
    }
  });
});

describe("診斷資訊", () => {
  const NOW = Date.UTC(2026, 10, 19, 12);
  const report = (camera: Camera, ptz: Awaited<ReturnType<PtzHub["inspect"]>>) =>
    buildDiagnostics({
      now: NOW,
      version: "t",
      runtime: { bun: "1", platform: "p", arch: "a", uptimeMs: 1000, timeZone: "UTC" },
      settings: defaultSettings("/data"),
      cameras: [{ camera, online: true, recording: false, probe: null, ptz }],
      only: null,
      workers: [],
      restarts: [],
      disk: { path: "/d", totalBytes: 10, freeBytes: 5 },
      dataDisk: { path: "/d", totalBytes: 10, freeBytes: 5, sameAsRecordings: true },
      usage: [],
      elsewhere: [],
    });

  test("列出能力與偏好", async () => {
    const f = await startFake();
    const c = onFake(f, "cam", { mode: "relative", speed: 0.7 });
    const text = report(c, await hub.inspect(c.id, 3000));
    expect(text).toContain("有 PTZ（持續移動、相對移動；沒有變焦；預置點上限 8）");
    expect(text).toContain("移動模式 relative，預設速度 0.7");
    expect(text).toContain("ONVIF 最近的錯誤：無");
  });

  test("連不上時列出錯誤種類，且不含密碼", async () => {
    const dead = await startFake();
    const endpoint = dead.endpoint;
    await dead.stop();
    const c = addCamera(rtspCamera("dead", endpoint));
    const text = report(c, await hub.inspect(c.id, 3000));
    expect(text).toContain("尚未連上過，能力未知");
    expect(text).toContain("ONVIF 最近的錯誤：unreachable");
    expect(text).not.toContain(endpoint.password);
  });

  test("沒有設定 ONVIF 的相機標示未設定", async () => {
    const c = addCamera(rtspCamera("plain"));
    expect(report(c, await hub.inspect(c.id, 100))).toContain("ONVIF／PTZ：未設定 ONVIF");
  });

  test("逾時時用目前已知的資訊，不卡住診斷", async () => {
    const f = await startFake();
    f.delays.set("GetProfiles", 2000);
    const c = onFake(f);
    const started = Date.now();
    const d = await hub.inspect(c.id, 200);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(d.caps).toBe("unknown");
  });
});
