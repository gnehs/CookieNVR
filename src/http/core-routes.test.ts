import { beforeEach, describe, expect, test } from "bun:test";
import type { CameraDto, MeDto, ProbeResult, SystemDto } from "../api-types.ts";
import { createAuth } from "../auth/index.ts";
import { openDb } from "../db.ts";
import { createCameraStore, createSettingsStore } from "../stores/index.ts";
import type { CameraConfig, Route } from "../types.ts";
import { coreRoutes } from "./core-routes.ts";
import { createRouter, type ServerLike } from "./router.ts";

const camera: CameraConfig = {
  name: "Door",
  enabled: true,
  connection: {
    type: "rtsp",
    mainUrl: "rtsp://admin:s3cret@10.0.0.5/main",
    subUrl: "rtsp://admin:s3cret@10.0.0.5/sub",
    transport: "tcp",
    onvif: { host: "10.0.0.5", port: 2020, username: "onvif", password: "onvif-pass" },
  },
  record: { enabled: true, audio: true, direct: false },
};
const tapo: CameraConfig = {
  ...camera,
  name: "Tapo",
  connection: { type: "tapo", host: "10.0.0.6", username: "tapo-user", password: "tapo-pass" },
};

let restarted: string[];
let purged: string[];
let diagnosed: (string | null)[];
let probed: unknown[];
let call: (path: string, init?: RequestInit & { ip?: string; json?: unknown }) => Promise<Response>;
let adminCookie: string;
let userCookie: string;

async function send(
  handler: ReturnType<typeof createRouter>,
  path: string,
  init: RequestInit & { ip?: string; json?: unknown } = {},
) {
  const { ip = "127.0.0.1", json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) {
    headers.set("content-type", "application/json");
    rest.body = JSON.stringify(json);
  }
  const server: ServerLike = { requestIP: () => ({ address: ip }) };
  return handler(new Request(`http://nvr.local${path}`, { ...rest, headers }), server);
}

function cookieOf(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  return set.split(";")[0]!;
}

beforeEach(async () => {
  restarted = [];
  purged = [];
  diagnosed = [];
  probed = [];
  const db = openDb(":memory:");
  const auth = createAuth({ db });
  const cameras = createCameraStore(db);
  const settings = createSettingsStore(db, "/data");
  const routes: Route[] = [
    ...coreRoutes({
      auth,
      cameras,
      settings,
      version: "1.2.3",
      instanceId: "00000000-0000-4000-8000-000000000000",
      probe: async (conn): Promise<ProbeResult> => {
        probed.push(conn);
        return { ok: false, error: "unreachable", errorMsg: { code: "raw", params: { text: "unreachable" } }, stream: "main" };
      },
      system: async (): Promise<SystemDto> => ({
        workers: [],
        disk: { path: "/data", totalBytes: 10, freeBytes: 5 },
        dataDisk: { path: "/data", totalBytes: 10, freeBytes: 5, sameAsRecordings: true },
        usage: [],
        elsewhere: [],
        logs: ["hello"],
        decode: { requested: "cpu", cameras: [], warning: null, warningMsg: null },
      }),
      diagnostics: async (only) => {
        diagnosed.push(only);
        return `report for ${only ?? "all"}`;
      },
      cameraStatus: () => ({ online: true, recording: false }),
      rtspUrls: (id) => ({ main: `rtsp://nvr:8554/${id}/main`, sub: `rtsp://nvr:8554/${id}/sub` }),
      purgeRecordings: (id) => void purged.push(id),
      supervisor: { restart: (id) => void restarted.push(id) },
    }),
    { method: "GET", path: "/internal/ping", access: "internal", handler: () => new Response("pong") },
    {
      method: "GET",
      path: "/boom",
      access: "public",
      handler() {
        throw new Error("kaboom");
      },
    },
  ];
  const handler = createRouter(routes, auth);
  call = (path, init) => send(handler, path, init);

  const setup = await call("/api/auth/setup", { method: "POST", json: { username: "root", password: "password1" } });
  adminCookie = cookieOf(setup);
  const created = await call("/api/users", {
    method: "POST",
    headers: { cookie: adminCookie },
    json: { username: "bob", password: "password1", role: "user" },
  });
  expect(created.status).toBe(201);
  const login = await call("/api/auth/login", { method: "POST", json: { username: "bob", password: "password1" } });
  userCookie = cookieOf(login);
});

const as = (cookie: string) => ({ headers: { cookie } });

describe("權限矩陣", () => {
  const cases: { method: string; path: string; json?: unknown; access: "public" | "user" | "admin" }[] = [
    { method: "GET", path: "/api/info", access: "public" },
    { method: "GET", path: "/api/me", access: "user" },
    { method: "GET", path: "/api/me/sessions", access: "user" },
    { method: "GET", path: "/api/tokens", access: "user" },
    { method: "POST", path: "/api/tokens", json: { name: "tv" }, access: "admin" },
    { method: "GET", path: "/api/cameras", access: "user" },
    { method: "GET", path: "/api/users", access: "admin" },
    { method: "GET", path: "/api/settings", access: "admin" },
    { method: "PUT", path: "/api/settings", json: {}, access: "admin" },
    { method: "POST", path: "/api/cameras", json: camera, access: "admin" },
    { method: "POST", path: "/api/cameras/test", json: camera.connection, access: "admin" },
    { method: "GET", path: "/api/system", access: "admin" },
    { method: "GET", path: "/api/system/diagnostics", access: "admin" },
    { method: "POST", path: "/api/system/workers/record:abc/restart", access: "admin" },
  ];

  for (const c of cases) {
    test(`${c.method} ${c.path} (${c.access})`, async () => {
      const run = (headers?: Record<string, string>) =>
        call(c.path, { method: c.method, json: c.json, headers });
      const anon = await run();
      const user = await run({ cookie: userCookie });
      const admin = await run({ cookie: adminCookie });
      if (c.access === "public") {
        expect([anon.status, user.status, admin.status].every((s) => s < 300)).toBe(true);
        return;
      }
      expect(anon.status).toBe(401);
      expect(user.status).toBe(c.access === "admin" ? 403 : 200);
      expect(admin.status).toBeLessThan(300);
    });
  }

  test("internal 路由只接受本機，且不能帶 forwarding 標頭", async () => {
    expect((await call("/internal/ping")).status).toBe(200);
    expect((await call("/internal/ping", { ip: "::1" })).status).toBe(200);
    expect((await call("/internal/ping", { ip: "192.168.1.9" })).status).toBe(403);
    expect((await call("/internal/ping", { headers: { "x-forwarded-for": "8.8.8.8" } })).status).toBe(403);
  });
});

describe("站點名稱與診斷資訊", () => {
  test("/api/info 帶站點名稱，改名後立刻反映", async () => {
    expect(((await (await call("/api/info")).json()) as { siteName: string }).siteName).toBe("CookieNVR");
    await call("/api/settings", { method: "PUT", ...as(adminCookie), json: { siteName: "我家" } });
    expect(((await (await call("/api/info")).json()) as { siteName: string }).siteName).toBe("我家");
  });

  test("診斷資訊是純文字，?camera= 只帶那一台", async () => {
    const all = await call("/api/system/diagnostics", as(adminCookie));
    expect(all.headers.get("content-type")).toStartWith("text/plain");
    expect(await all.text()).toBe("report for all");
    const one = await call("/api/system/diagnostics?camera=cam9", as(adminCookie));
    expect(await one.text()).toBe("report for cam9");
    expect(diagnosed).toEqual([null, "cam9"]);
  });
});

describe("路由與錯誤", () => {
  test("404、405、未捕捉例外轉 500 且格式為 { error }", async () => {
    const notFound = await call("/api/nope");
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toHaveProperty("error");
    const wrongMethod = await call("/api/info", { method: "POST", json: {} });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    const orig = console.error;
    console.error = () => {};
    const boom = await call("/boom");
    console.error = orig;
    expect(boom.status).toBe(500);
    expect(await boom.json()).toEqual({ error: expect.any(String), code: "internal" });
  });

  test("變更類請求有 body 時只接受 application/json，沒有 body 的可以", async () => {
    const wrong = await call("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "username=root",
    });
    expect(wrong.status).toBe(415);
    const form = await call("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=b",
    });
    expect(form.status).toBe(415);
    const noBody = await call("/api/auth/logout", { method: "POST" });
    expect(noBody.status).toBe(204);
  });

  test("無效 JSON 回 400，欄位錯誤回 400 與說明", async () => {
    const bad = await call("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    expect(bad.status).toBe(400);
    const missing = await call("/api/auth/login", { method: "POST", json: { username: "root" } });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toContain("password");
  });

  test("fallback 處理沒有符合的路徑", async () => {
    const auth = createAuth({ db: openDb(":memory:") });
    const handler = createRouter([], auth, { fallback: () => new Response("spa") });
    expect(await (await send(handler, "/anything")).text()).toBe("spa");
  });
});

describe("認證流程", () => {
  test("info 反映是否需要初始設定", async () => {
    expect(await (await call("/api/info")).json()).toEqual({ version: "1.2.3", apiVersion: 1, needsSetup: false, siteName: "CookieNVR", instanceId: "00000000-0000-4000-8000-000000000000" });
  });

  test("setup 在已有帳號時回 409", async () => {
    const res = await call("/api/auth/setup", { method: "POST", json: { username: "x", password: "password1" } });
    expect(res.status).toBe(409);
  });

  test("登入設定 cookie（HttpOnly、SameSite=Lax；HTTPS 才有 Secure），錯誤回 401", async () => {
    const ok = await call("/api/auth/login", { method: "POST", json: { username: "bob", password: "password1" } });
    const set = ok.headers.get("set-cookie")!;
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    expect(set).not.toContain("Secure");
    expect((await ok.json()) as MeDto).toMatchObject({ username: "bob", role: "user" });

    const secure = await call("/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-proto": "https" },
      json: { username: "bob", password: "password1" },
    });
    expect(secure.headers.get("set-cookie")).toContain("Secure");

    const bad = await call("/api/auth/login", { method: "POST", json: { username: "bob", password: "wrongwrong" } });
    expect(bad.status).toBe(401);
  });

  test("連續登入失敗後回 429 並帶 Retry-After", async () => {
    let last!: Response;
    for (let i = 0; i < 6; i++) {
      last = await call("/api/auth/login", { method: "POST", json: { username: "bob", password: "wrongwrong" } });
    }
    expect(last.status).toBe(429);
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("登出後 session 失效並清除 cookie", async () => {
    const out = await call("/api/auth/logout", { method: "POST", ...as(userCookie) });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await call("/api/me", as(userCookie))).status).toBe(401);
  });

  test("改密碼：目前密碼錯 403；成功後其他 session 失效、自己仍有效", async () => {
    const other = cookieOf(
      await call("/api/auth/login", { method: "POST", json: { username: "bob", password: "password1" } }),
    );
    const wrong = await call("/api/me", {
      method: "PUT",
      ...as(userCookie),
      json: { currentPassword: "nope-nope", newPassword: "newpassword" },
    });
    expect(wrong.status).toBe(403);
    const ok = await call("/api/me", {
      method: "PUT",
      ...as(userCookie),
      json: { currentPassword: "password1", newPassword: "newpassword" },
    });
    expect(ok.status).toBe(204);
    expect((await call("/api/me", as(userCookie))).status).toBe(200);
    expect((await call("/api/me", as(other))).status).toBe(401);
  });

  test("登入裝置清單與撤銷", async () => {
    const other = cookieOf(
      await call("/api/auth/login", { method: "POST", json: { username: "bob", password: "password1" } }),
    );
    const list = (await (await call("/api/me/sessions", as(userCookie))).json()) as { id: string; current: boolean }[];
    expect(list).toHaveLength(2);
    const target = list.find((s) => !s.current)!;
    expect((await call(`/api/me/sessions/${target.id}`, { method: "DELETE", ...as(userCookie) })).status).toBe(204);
    expect((await call("/api/me", as(other))).status).toBe(401);
    expect((await call(`/api/me/sessions/${target.id}`, { method: "DELETE", ...as(userCookie) })).status).toBe(404);
  });
});

describe("API token", () => {
  test("建立、Bearer 與 ?token= 使用、列表、撤銷；只能看到自己的", async () => {
    const created = await call("/api/tokens", { method: "POST", ...as(adminCookie), json: { name: "tv" } });
    expect(created.status).toBe(201);
    const { id, token } = (await created.json()) as { id: number; token: string };
    expect(token).toStartWith("cnvr_");

    expect((await call("/api/me", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await call(`/api/cameras?token=${token}`)).status).toBe(200);

    const mine = (await (await call("/api/tokens", as(adminCookie))).json()) as { lastUsedAt: number | null }[];
    expect(mine).toHaveLength(1);
    expect(mine[0]?.lastUsedAt).not.toBeNull();
    expect(JSON.stringify(mine)).not.toContain(token);
    expect(await (await call("/api/tokens", as(userCookie))).json()).toEqual([]);

    expect((await call(`/api/tokens/${id}`, { method: "DELETE", ...as(userCookie) })).status).toBe(404);
    expect((await call(`/api/tokens/${id}`, { method: "DELETE", ...as(adminCookie) })).status).toBe(204);
    expect((await call("/api/me", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  test("一般使用者不能建立 token", async () => {
    expect((await call("/api/tokens", { method: "POST", ...as(userCookie), json: { name: "tv" } })).status).toBe(403);
  });
});

describe("使用者管理", () => {
  test("管理員不能刪除或降級自己（最後一位管理員）", async () => {
    const users = (await (await call("/api/users", as(adminCookie))).json()) as { id: number; username: string }[];
    const root = users.find((u) => u.username === "root")!;
    expect((await call(`/api/users/${root.id}`, { method: "DELETE", ...as(adminCookie) })).status).toBe(409);
    const demote = await call(`/api/users/${root.id}`, { method: "PUT", ...as(adminCookie), json: { role: "user" } });
    expect(demote.status).toBe(409);
  });

  test("提升、重設密碼、刪除", async () => {
    const users = (await (await call("/api/users", as(adminCookie))).json()) as { id: number; username: string }[];
    const bob = users.find((u) => u.username === "bob")!;
    const up = await call(`/api/users/${bob.id}`, { method: "PUT", ...as(adminCookie), json: { role: "admin" } });
    expect(((await up.json()) as { role: string }).role).toBe("admin");
    expect((await call("/api/users", as(userCookie))).status).toBe(200);
    expect((await call(`/api/users/${bob.id}`, { method: "PUT", ...as(adminCookie), json: {} })).status).toBe(400);
    expect((await call("/api/users/9999", { method: "DELETE", ...as(adminCookie) })).status).toBe(404);
    expect((await call(`/api/users/${bob.id}`, { method: "DELETE", ...as(adminCookie) })).status).toBe(204);
  });

  test("回應不含密碼雜湊", async () => {
    const text = await (await call("/api/users", as(adminCookie))).text();
    expect(text).not.toContain("argon2");
    expect(text).not.toContain("password");
  });
});

describe("攝影機", () => {
  test("管理員拿到完整設定，一般使用者的帳密與網址中的帳密被移除", async () => {
    const created = await call("/api/cameras", { method: "POST", ...as(adminCookie), json: camera });
    expect(created.status).toBe(201);
    await call("/api/cameras", { method: "POST", ...as(adminCookie), json: tapo });

    const admin = (await (await call("/api/cameras", as(adminCookie))).json()) as CameraDto[];
    expect(admin[0]?.config).toEqual(camera);
    expect(JSON.stringify(admin)).toContain("s3cret");

    const raw = await (await call("/api/cameras", as(userCookie))).text();
    for (const secret of ["s3cret", "onvif-pass", "tapo-pass", "tapo-user", "admin:"]) {
      expect(raw).not.toContain(secret);
    }
    const user = JSON.parse(raw) as CameraDto[];
    expect(user[0]?.config.connection).toMatchObject({
      mainUrl: "rtsp://10.0.0.5/main",
      subUrl: "rtsp://10.0.0.5/sub",
      onvif: { host: "10.0.0.5", password: "" },
    });
    expect(user[1]?.config.connection).toMatchObject({ type: "tapo", host: "10.0.0.6", password: "" });
    expect(user[0]).toMatchObject({ online: true, recording: false });
    expect(user[0]?.rtsp.main).toBe(`rtsp://nvr:8554/${user[0]?.id}/main`);
  });

  test("刪除時帶 recordings=delete 才會清錄影", async () => {
    const create = async () =>
      ((await (await call("/api/cameras", { method: "POST", ...as(adminCookie), json: camera })).json()) as CameraDto).id;
    const keep = await create();
    const drop = await create();
    expect((await call(`/api/cameras/${keep}`, { method: "DELETE", ...as(adminCookie) })).status).toBe(204);
    expect(purged).toEqual([]);
    expect((await call(`/api/cameras/${drop}?recordings=keep`, { method: "DELETE", ...as(adminCookie) })).status).toBe(400);
    expect(purged).toEqual([]);
    expect((await call(`/api/cameras/${drop}?recordings=delete`, { method: "DELETE", ...as(userCookie) })).status).toBe(403);
    expect(purged).toEqual([]);
    expect((await call(`/api/cameras/${drop}?recordings=delete`, { method: "DELETE", ...as(adminCookie) })).status).toBe(204);
    expect(purged).toEqual([drop]);
    expect((await call(`/api/cameras/${drop}?recordings=delete`, { method: "DELETE", ...as(adminCookie) })).status).toBe(404);
    expect(purged).toEqual([drop]);
  });

  test("修改與刪除，找不到回 404", async () => {
    const { id } = (await (
      await call("/api/cameras", { method: "POST", ...as(adminCookie), json: camera })
    ).json()) as CameraDto;
    const put = await call(`/api/cameras/${id}`, {
      method: "PUT",
      ...as(adminCookie),
      json: { ...camera, name: "Renamed", record: { enabled: false, audio: false, direct: true } },
    });
    expect(((await put.json()) as CameraDto).config.name).toBe("Renamed");
    expect((await call("/api/cameras/nope0000", { method: "PUT", ...as(adminCookie), json: camera })).status).toBe(404);
    expect((await call(`/api/cameras/${id}`, { method: "DELETE", ...as(adminCookie) })).status).toBe(204);
    expect((await call(`/api/cameras/${id}`, { method: "DELETE", ...as(adminCookie) })).status).toBe(404);
    expect(await (await call("/api/cameras", as(adminCookie))).json()).toEqual([]);
    expect(purged).toEqual([]);
  });

  test("驗證外部輸入", async () => {
    const post = (json: unknown) => call("/api/cameras", { method: "POST", ...as(adminCookie), json });
    expect((await post({ ...camera, name: "" })).status).toBe(400);
    expect((await post({ ...camera, enabled: "yes" })).status).toBe(400);
    expect((await post({ ...camera, record: undefined })).status).toBe(400);
    expect((await post({ ...camera, connection: { type: "ftp" } })).status).toBe(400);
    expect(
      (await post({ ...camera, connection: { type: "rtsp", mainUrl: "http://x/y", transport: "tcp" } })).status,
    ).toBe(400);
    expect(
      (await post({ ...camera, connection: { type: "rtsp", mainUrl: "rtsp://x/y", transport: "sctp" } })).status,
    ).toBe(400);
    expect((await post([])).status).toBe(400);
    expect(await (await call("/api/cameras", as(adminCookie))).json()).toEqual([]);
  });

  test("未知欄位會被丟棄，不會存進資料庫", async () => {
    const res = await call("/api/cameras", {
      method: "POST",
      ...as(adminCookie),
      json: { ...camera, extra: "x", record: { ...camera.record, hack: 1 } },
    });
    const dto = (await res.json()) as CameraDto;
    expect(dto.config).toEqual(camera);
  });

  test("測試連線走注入的 probe", async () => {
    const res = await call("/api/cameras/test", { method: "POST", ...as(adminCookie), json: tapo.connection });
    expect(await res.json()).toEqual({ ok: false, error: "unreachable", errorMsg: { code: "raw", params: { text: "unreachable" } }, stream: "main" });
    expect(probed).toEqual([tapo.connection]);
    expect((await call("/api/cameras/test", { method: "POST", ...as(adminCookie), json: { type: "x" } })).status).toBe(
      400,
    );
  });
});

describe("設定與系統", () => {
  test("設定可部分更新，巢狀欄位沿用未送出的值", async () => {
    const res = await call("/api/settings", {
      method: "PUT",
      ...as(adminCookie),
      json: { siteName: "Home", retention: { continuousDays: 14 } },
    });
    const s = (await res.json()) as { siteName: string; retention: Record<string, number> };
    expect(s.siteName).toBe("Home");
    expect(s.retention.continuousDays).toBe(14);
    expect(s.retention.eventDays).toBe(30);
    expect(((await (await call("/api/settings", as(adminCookie))).json()) as { siteName: string }).siteName).toBe("Home");
  });

  test("設定驗證", async () => {
    const put = (json: unknown) => call("/api/settings", { method: "PUT", ...as(adminCookie), json });
    expect((await put({ siteName: "" })).status).toBe(400);
    expect((await put({ storagePath: "relative/path" })).status).toBe(400);
    expect((await put({ retention: { continuousDays: -1 } })).status).toBe(400);
    expect((await put({ retention: { continuousDays: 1.5 } })).status).toBe(400);
    expect((await put({ rtsp: { externalEnabled: "no" } })).status).toBe(400);
    expect((await put({ unknown: 1 })).status).toBe(400);
  });

  test("系統狀態與重啟 worker", async () => {
    const sys = (await (await call("/api/system", as(adminCookie))).json()) as SystemDto;
    expect(sys.logs).toEqual(["hello"]);
    const res = await call("/api/system/workers/record:abc/restart", { method: "POST", ...as(adminCookie) });
    expect(res.status).toBe(204);
    expect(restarted).toEqual(["record:abc"]);
  });
});

describe("camera groups and layout", () => {
  const admin = (init: RequestInit & { json?: unknown } = {}) => ({ ...init, headers: { cookie: adminCookie } });
  const createCam = async (config: CameraConfig) =>
    ((await (await call("/api/cameras", admin({ method: "POST", json: config }))).json()) as CameraDto).id;
  const createGroup = async (name: string) =>
    ((await (await call("/api/camera-groups", admin({ method: "POST", json: { name } }))).json()) as { id: string }).id;

  test("admins create, rename and delete groups; users only list them", async () => {
    const id = await createGroup("  一樓  ");
    expect((await call(`/api/camera-groups/${id}`, admin({ method: "PUT", json: { name: "樓下" } }))).status).toBe(200);
    expect(await (await call("/api/camera-groups", as(userCookie))).json()).toEqual([{ id, name: "樓下" }]);
    expect((await call("/api/camera-groups", { method: "POST", headers: { cookie: userCookie }, json: { name: "x" } })).status).toBe(403);
    expect((await call(`/api/camera-groups/${id}`, admin({ method: "DELETE" }))).status).toBe(204);
    expect((await call(`/api/camera-groups/${id}`, admin({ method: "DELETE" }))).status).toBe(404);
  });

  test("a blank group name is rejected", async () => {
    expect((await call("/api/camera-groups", admin({ method: "POST", json: { name: "   " } }))).status).toBe(400);
  });

  test("PUT /api/camera-layout reorders cameras into groups and the camera list follows", async () => {
    const door = await createCam(camera);
    const yard = await createCam(tapo);
    const g = await createGroup("戶外");
    const res = await call("/api/camera-layout", admin({ method: "PUT", json: { groups: [g], cameras: [{ id: yard, groupId: null }, { id: door, groupId: g }] } }));
    expect(res.status).toBe(200);
    const list = (await (await call("/api/cameras", as(userCookie))).json()) as CameraDto[];
    expect(list.map((c) => [c.config.name, c.groupId])).toEqual([
      ["Tapo", null],
      ["Door", g],
    ]);
    expect((await call("/api/camera-layout", { method: "PUT", headers: { cookie: userCookie }, json: { groups: [], cameras: [] } })).status).toBe(403);
    expect((await call("/api/camera-layout", admin({ method: "PUT", json: { groups: "x", cameras: [] } }))).status).toBe(400);
  });
});
