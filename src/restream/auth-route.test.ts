import { expect, test } from "bun:test";
import { buildRtspAuthRoute } from "./auth-route.ts";

const internal = { username: "nvr-internal", secret: "s3cret" };

function setup(opts: { externalEnabled?: boolean; accounts?: Record<string, string> } = {}) {
  const accounts = opts.accounts ?? { alice: "pw" };
  const route = buildRtspAuthRoute(internal, {
    externalEnabled: () => opts.externalEnabled ?? true,
    verify: async (u, s) => accounts[u] === s,
  });
  return async (payload: unknown) => {
    const req = new Request("http://127.0.0.1/internal/rtsp-auth", {
      method: "POST",
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
    const res = await route.handler({ req, url: new URL(req.url), params: {}, principal: null, ip: "127.0.0.1" });
    return res.status;
  };
}

const read = (user: string, password: string) => ({ action: "read", user, password, path: "cam/main" });

test("路由是只限本機的 POST /internal/rtsp-auth", () => {
  const route = buildRtspAuthRoute(internal, { verify: async () => true, externalEnabled: () => true });
  expect([route.method, route.path, route.access]).toEqual(["POST", "/internal/rtsp-auth", "internal"]);
});

test("內部帳密放行，不問 verify，也不受對外 RTSP 開關影響", async () => {
  const auth = setup({ externalEnabled: false, accounts: {} });
  expect(await auth(read("nvr-internal", "s3cret"))).toBe(200);
});

test("內部帳號配錯密碼不放行", async () => {
  expect(await setup()(read("nvr-internal", "wrong"))).toBe(401);
});

test("外部讀取：帳密正確放行，錯誤或沒帶帳密拒絕", async () => {
  const auth = setup();
  expect(await auth(read("alice", "pw"))).toBe(200);
  expect(await auth(read("alice", "bad"))).toBe(401);
  expect(await auth(read("", ""))).toBe(401);
});

test("把 MediaMTX 回報的用戶端位址交給 verify，讓失敗的嘗試能依位址限流", async () => {
  const seen: string[] = [];
  const route = buildRtspAuthRoute(internal, { externalEnabled: () => true, verify: async (_u, _s, ip) => (seen.push(ip), false) });
  for (const extra of [{ ip: "192.168.1.50" }, {}]) {
    const req = new Request("http://127.0.0.1/internal/rtsp-auth", { method: "POST", body: JSON.stringify({ ...read("alice", "bad"), ...extra }) });
    await route.handler({ req, url: new URL(req.url), params: {}, principal: null, ip: "127.0.0.1" });
  }
  expect(seen).toEqual(["192.168.1.50", "unknown"]);
});

test("關閉對外 RTSP 時拒絕所有非內部連線", async () => {
  expect(await setup({ externalEnabled: false })(read("alice", "pw"))).toBe(403);
});

test("外部帳號不能推流，也不能呼叫 API 或其他動作", async () => {
  const auth = setup();
  for (const action of ["publish", "playback", "api", "metrics"]) {
    expect(await auth({ action, user: "alice", password: "pw", path: "cam/main" })).toBe(403);
  }
});

test("內部帳密同樣只能讀取", async () => {
  expect(await setup()({ action: "publish", user: "nvr-internal", password: "s3cret" })).toBe(403);
});

test("壞掉的請求內容回 400", async () => {
  const auth = setup();
  expect(await auth("not json")).toBe(400);
  expect(await auth("null")).toBe(400);
});
