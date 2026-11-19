import { beforeEach, describe, expect, test } from "bun:test";
import type { LinkCreatedDto, LinkPollDto, LinkRequestDto } from "../api-types.ts";
import { createAuth, type Auth } from "../auth/index.ts";
import { createLinkService, LINK_TTL_MS } from "../auth/link.ts";
import { openDb } from "../db.ts";
import { loadInstanceId } from "../discovery/instance-id.ts";
import { authRoutes } from "./auth-routes.ts";
import { linkRoutes } from "./link-routes.ts";
import { createRouter, type ServerLike } from "./router.ts";

type Init = RequestInit & { ip?: string; json?: unknown; cookie?: string; site?: string | null };

let clock: number;
let auth: Auth;
let handler: ReturnType<typeof createRouter>;
let adminCookie: string;
let userCookie: string;

async function call(path: string, init: Init = {}): Promise<Response> {
  const { ip = "10.0.0.9", json, cookie, site = "same-origin", ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) {
    headers.set("content-type", "application/json");
    rest.body = JSON.stringify(json);
    rest.method ??= "POST";
  }
  if (cookie) headers.set("cookie", cookie);
  if (site !== null) headers.set("sec-fetch-site", site);
  const server: ServerLike = { requestIP: () => ({ address: ip }) };
  return handler(new Request(`http://nvr.lan:8765${path}`, { ...rest, headers }), server);
}

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

async function start(ip = "10.0.0.9"): Promise<LinkCreatedDto> {
  const res = await call("/api/link", { json: { app: "Home Assistant" }, ip });
  expect(res.status).toBe(201);
  return res.json();
}

const poll = async (pollSecret: string, ip = "10.0.0.9") => call("/api/link/poll", { json: { pollSecret }, ip });
const pollBody = async (pollSecret: string): Promise<LinkPollDto> => (await poll(pollSecret)).json();
const decide = (code: string, decision: string, init: Init = {}) =>
  call(`/api/link/${code}`, { json: { decision }, cookie: adminCookie, ...init });

beforeEach(async () => {
  clock = 1_700_000_000_000;
  const db = openDb(":memory:");
  auth = createAuth({ db, now: () => clock });
  const links = createLinkService({ tokens: auth, now: () => clock });
  handler = createRouter([...authRoutes(auth, "1.0.0", () => "CookieNVR", loadInstanceId(db)), ...linkRoutes(links, { proveToken: auth.proveToken, instanceId: "nvr-1" })], auth);
  adminCookie = cookieOf(await call("/api/auth/setup", { json: { username: "admin", password: "password1" } }));
  await auth.createUser("viewer", "password1", "user");
  userCookie = cookieOf(await call("/api/auth/login", { json: { username: "viewer", password: "password1" } }));
});

describe("link request lifecycle", () => {
  test("approve, then the poller collects a working token exactly once", async () => {
    const link = await start();
    expect(link.code).toMatch(/^[B-Z]{4}-[B-Z]{4}$/);
    expect(link.approveUrl).toBe(`http://nvr.lan:8765/link/${link.code}`);
    expect(link.interval).toBe(2);
    expect(link.pollSecret).not.toContain(link.code.replace("-", ""));

    expect(await pollBody(link.pollSecret)).toEqual({ status: "pending" });

    const view = await call(`/api/link/${link.code.toLowerCase()}`, { cookie: userCookie });
    expect(view.status).toBe(200);
    expect((await view.json()) as LinkRequestDto).toMatchObject({ code: link.code, app: "Home Assistant", ip: "10.0.0.9", status: "pending" });

    const approved = await decide(link.code, "approve", { cookie: userCookie });
    expect(approved.status).toBe(200);
    expect((await approved.json()).status).toBe("approved");

    const got = await pollBody(link.pollSecret);
    expect(got).toMatchObject({ status: "approved", username: "viewer", role: "user" });
    const token = (got as { token: string }).token;
    expect(token.startsWith("cnvr_")).toBe(true);
    const me = await handler(new Request("http://nvr.lan/api/me", { headers: { authorization: `Bearer ${token}` } }));
    expect(await me.json()).toMatchObject({ username: "viewer", role: "user" });

    expect(await pollBody(link.pollSecret)).toEqual({ status: "claimed" });
    const viewer = auth.listUsers().find((u) => u.username === "viewer")!;
    expect(auth.listTokens(viewer.id).map((t) => t.name)).toEqual(["Home Assistant（10.0.0.9，2023-11-14）"]);
  });

  test("a token is only minted when collected, so an approved but abandoned request leaves nothing behind", async () => {
    const link = await start();
    await decide(link.code, "approve");
    clock += LINK_TTL_MS;
    expect(await pollBody(link.pollSecret)).toEqual({ status: "expired" });
    expect(auth.listTokens(1)).toEqual([]);
  });

  test("deny is final", async () => {
    const link = await start();
    expect((await (await decide(link.code, "deny")).json()).status).toBe("denied");
    expect(await pollBody(link.pollSecret)).toEqual({ status: "denied" });
    expect((await decide(link.code, "approve")).status).toBe(409);
    expect(await pollBody(link.pollSecret)).toEqual({ status: "denied" });
  });

  test("a request can be decided only once", async () => {
    const link = await start();
    expect((await decide(link.code, "approve")).status).toBe(200);
    expect((await decide(link.code, "approve")).status).toBe(409);
    expect((await decide(link.code, "deny")).status).toBe(409);
  });

  test("expired requests cannot be approved and report expired until they are forgotten", async () => {
    const link = await start();
    clock += LINK_TTL_MS;
    expect(await pollBody(link.pollSecret)).toEqual({ status: "expired" });
    expect((await decide(link.code, "approve")).status).toBe(410);
    clock += 11 * 60_000;
    expect((await poll(link.pollSecret)).status).toBe(404);
    expect((await call(`/api/link/${link.code}`, { cookie: adminCookie })).status).toBe(404);
  });

  test("knowing the short code is not enough to collect the token", async () => {
    const link = await start();
    await decide(link.code, "approve");
    for (const guess of [link.code, link.code.replace("-", ""), "x".repeat(43)]) {
      expect((await poll(guess)).status).toBe(404);
    }
    expect((await pollBody(link.pollSecret)).status).toBe("approved");
  });

  test("an admin's approval gives an admin token", async () => {
    const link = await start();
    await decide(link.code, "approve");
    expect(await pollBody(link.pollSecret)).toMatchObject({ status: "approved", username: "admin", role: "admin" });
  });

  test("an approver deleted before collection gets no token", async () => {
    const link = await start();
    await decide(link.code, "approve", { cookie: userCookie });
    auth.removeUser(auth.listUsers().find((u) => u.username === "viewer")!.id);
    expect(await pollBody(link.pollSecret)).toEqual({ status: "denied" });
  });
});

describe("approval is a deliberate same-origin action by a signed-in person", () => {
  test("requires a signed-in browser session", async () => {
    const link = await start();
    expect((await call(`/api/link/${link.code}`)).status).toBe(401);
    expect((await decide(link.code, "approve", { cookie: "" })).status).toBe(401);
    const { token } = auth.createToken(1, "script");
    const viaToken = await call(`/api/link/${link.code}`, {
      json: { decision: "approve" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(viaToken.status).toBe(403);
    expect(await pollBody(link.pollSecret)).toEqual({ status: "pending" });
  });

  test("rejects cross-site requests (CSRF)", async () => {
    const link = await start();
    expect((await decide(link.code, "approve", { site: "cross-site" })).status).toBe(403);
    expect((await decide(link.code, "approve", { site: "same-site" })).status).toBe(403);
    // 沒有 Fetch Metadata 的舊瀏覽器退回比對 Origin 與 Host
    expect((await decide(link.code, "approve", { site: null, headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect((await decide(link.code, "approve", { site: null })).status).toBe(403);
    // 表單送出（非 JSON）在路由層就被擋下
    const form = await call(`/api/link/${link.code}`, {
      method: "POST",
      body: "decision=approve",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      cookie: adminCookie,
    });
    expect(form.status).toBe(415);
    expect(await pollBody(link.pollSecret)).toEqual({ status: "pending" });
    const legacy = await decide(link.code, "approve", { site: null, headers: { origin: "http://nvr.lan:8765" } });
    expect(legacy.status).toBe(200);
  });

  test("validates the decision and the app name", async () => {
    const link = await start();
    expect((await decide(link.code, "maybe")).status).toBe(400);
    expect((await call("/api/link", { json: { app: "" } })).status).toBe(400);
    expect((await call("/api/link", { json: { app: "x".repeat(41) } })).status).toBe(400);
    expect((await call("/api/link", { json: { app: "Home\u0007Assistant" } })).status).toBe(400);
  });

  test("shows IPv4-mapped addresses as plain IPv4", async () => {
    const link = await start("::ffff:192.168.1.20");
    expect((await (await call(`/api/link/${link.code}`, { cookie: adminCookie })).json()).ip).toBe("192.168.1.20");
  });

  test("responses carrying secrets are not cached", async () => {
    const res = await call("/api/link", { json: { app: "Home Assistant" } });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("rate limits", () => {
  test("caps pending requests per IP and creation rate per IP", async () => {
    for (let i = 0; i < 5; i++) await start("10.0.0.50");
    const sixth = await call("/api/link", { json: { app: "Home Assistant" }, ip: "10.0.0.50" });
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
    await start("10.0.0.51");

    clock += LINK_TTL_MS;
    for (let i = 0; i < 5; i++) await start("10.0.0.50");
    expect((await call("/api/link", { json: { app: "Home Assistant" }, ip: "10.0.0.50" })).status).toBe(429);
    clock += LINK_TTL_MS;
    await start("10.0.0.50");
  });

  test("locks out an IP that keeps polling with wrong secrets", async () => {
    const link = await start("10.0.0.60");
    for (let i = 0; i < 20; i++) expect((await poll(`wrong-${i}`, "10.0.0.60")).status).toBe(404);
    expect((await poll(link.pollSecret, "10.0.0.60")).status).toBe(429);
    clock += 10 * 60_000;
    expect((await poll(link.pollSecret, "10.0.0.60")).status).toBe(200);
  });

  test("throttles very fast polling", async () => {
    const link = await start();
    let last = 0;
    for (let i = 0; i < 91; i++) last = (await poll(link.pollSecret)).status;
    expect(last).toBe(429);
  });

  test("a signed-in user guessing short codes is locked out", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await call(`/api/link/BBBB-BBB${"CDFGHJKLMN"[i]}`, { cookie: userCookie })).status).toBe(404);
    }
    const link = await start();
    expect((await call(`/api/link/${link.code}`, { cookie: userCookie })).status).toBe(429);
    expect((await call(`/api/link/${link.code}`, { cookie: adminCookie })).status).toBe(200);
  });
});

describe("proving token possession without sending the token", () => {
  const hex = (alg: string, data: string, key?: string) =>
    (key ? new Bun.CryptoHasher("sha256", key) : new Bun.CryptoHasher(alg as "sha256")).update(data).digest("hex");

  test("answers an HMAC that only a holder of the token can predict, bound to this NVR", async () => {
    const { token } = auth.createToken(1, "Home Assistant");
    const key = hex("sha256", token);
    const lookup = hex("sha256", `cnvr-proof-id:${key}`);
    const res = await call("/api/link/proof", { json: { lookup, nonce: "n-1" } });
    expect(res.status).toBe(200);
    expect((await res.json()).proof).toBe(hex("sha256", "n-1|nvr-1", key));
    expect((await call("/api/link/proof", { json: { lookup: "0".repeat(64), nonce: "n-1" } })).status).toBe(404);
    auth.revokeToken(1, auth.listTokens(1)[0]!.id);
    expect((await call("/api/link/proof", { json: { lookup, nonce: "n-1" } })).status).toBe(404);
  });
});

test("expiresIn counts down from the NVR clock", async () => {
  const link = await start();
  expect(link.expiresIn).toBe(LINK_TTL_MS / 1000);
  clock += 60_000;
  const view = await (await call(`/api/link/${link.code}`, { cookie: adminCookie })).json();
  expect(view.expiresIn).toBe(LINK_TTL_MS / 1000 - 60);
});

test("the instance id is generated once and survives a restart", () => {
  const db = openDb(":memory:");
  const first = loadInstanceId(db);
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  expect(loadInstanceId(db)).toBe(first);
});
