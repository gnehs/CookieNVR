import { beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../db.ts";
import { createAuth, type Auth, type ClientInfo } from "./auth.ts";

const client: ClientInfo = { ip: "10.0.0.1", userAgent: "test" };
const DAY = 24 * 3600_000;

let t: number;
let auth: Auth;
let db: ReturnType<typeof openDb>;

function req(headers: Record<string, string> = {}, path = "/api/me", method = "GET") {
  const url = `http://nvr.local${path}`;
  return { req: new Request(url, { method, headers }), url: new URL(url) };
}
const authenticate = (headers: Record<string, string>, path?: string, method?: string) => {
  const { req: r, url } = req(headers, path, method);
  return auth.authenticate(r, url);
};
const cookie = (token: string) => ({ cookie: `cnvr_session=${token}` });

beforeEach(() => {
  t = 1_700_000_000_000;
  db = openDb(":memory:");
  auth = createAuth({ db, now: () => t });
});

describe("setup", () => {
  test("只有沒有任何帳號時可用，並建立管理員", async () => {
    expect(auth.needsSetup()).toBe(true);
    const r = await auth.setup("root", "password1", client);
    expect(r.user.role).toBe("admin");
    expect(auth.needsSetup()).toBe(false);
    await expect(auth.setup("other", "password1", client)).rejects.toMatchObject({ status: 409 });
  });

  test("密碼少於 8 字元被拒絕", async () => {
    await expect(auth.setup("root", "short", client)).rejects.toMatchObject({ status: 400 });
    expect(auth.needsSetup()).toBe(true);
  });

  test("同時兩個 setup 只有一個成功", async () => {
    const results = await Promise.allSettled([
      auth.setup("a", "password1", client),
      auth.setup("b", "password1", client),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(auth.listUsers()).toHaveLength(1);
  });
});

describe("session", () => {
  test("資料庫只存 token 的雜湊", async () => {
    const { sessionToken } = await auth.setup("root", "password1", client);
    const ids = (db.query("SELECT id FROM sessions").all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual([auth.sessionIdOf(sessionToken)]);
    expect(ids[0]).not.toBe(sessionToken);
    expect(authenticate(cookie(sessionToken))?.username).toBe("root");
  });

  test("cookie 屬性", () => {
    const c = auth.sessionCookie("abc", false);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).not.toContain("Secure");
    expect(auth.sessionCookie("abc", true)).toContain("Secure");
  });

  test("30 天後過期，使用中會延長", async () => {
    const { sessionToken } = await auth.setup("root", "password1", client);
    t += 20 * DAY;
    expect(authenticate(cookie(sessionToken))).not.toBeNull();
    t += 20 * DAY;
    expect(authenticate(cookie(sessionToken))).not.toBeNull();
    t += 31 * DAY;
    expect(authenticate(cookie(sessionToken))).toBeNull();
  });

  test("登出後 token 失效", async () => {
    const { sessionToken } = await auth.setup("root", "password1", client);
    auth.logout(sessionToken);
    expect(authenticate(cookie(sessionToken))).toBeNull();
  });

  test("改密碼登出其他 session、保留目前這個", async () => {
    const a = await auth.setup("root", "password1", client);
    const b = await auth.login("root", "password1", client);
    await auth.changePassword(a.user.id, "password1", "newpassword", auth.sessionIdOf(a.sessionToken));
    expect(authenticate(cookie(a.sessionToken))).not.toBeNull();
    expect(authenticate(cookie(b.sessionToken))).toBeNull();
    await expect(auth.login("root", "password1", client)).rejects.toMatchObject({ status: 401 });
    await auth.login("root", "newpassword", client);
  });

  test("目前密碼錯誤不能改密碼", async () => {
    const a = await auth.setup("root", "password1", client);
    await expect(auth.changePassword(a.user.id, "wrong-pass", "newpassword", null)).rejects.toMatchObject({
      status: 403,
    });
  });

  test("listSessions 標出目前的，revokeSession 只能撤銷自己的", async () => {
    const a = await auth.setup("root", "password1", client);
    const b = await auth.login("root", "password1", { ip: "10.0.0.2", userAgent: "phone" });
    const other = await auth.createUser("bob", "password1", "user");
    const sessions = auth.listSessions(a.user.id, auth.sessionIdOf(a.sessionToken));
    expect(sessions.map((s) => s.current)).toEqual(expect.arrayContaining([true, false]));
    expect(sessions).toHaveLength(2);
    const bobSession = await auth.login("bob", "password1", client);
    expect(auth.revokeSession(a.user.id, auth.sessionIdOf(bobSession.sessionToken))).toBe(false);
    expect(auth.revokeSession(a.user.id, auth.sessionIdOf(b.sessionToken))).toBe(true);
    expect(authenticate(cookie(b.sessionToken))).toBeNull();
    expect(other.role).toBe("user");
  });
});

describe("login 限流", () => {
  beforeEach(async () => {
    await auth.setup("root", "password1", client);
  });

  const fail = (ip = client.ip, user = "root") =>
    auth.login(user, "wrong-password", { ip, userAgent: "" }).catch((e) => e.status as number);

  test("連續失敗 5 次後鎖定，連正確密碼也被擋", async () => {
    for (let i = 0; i < 5; i++) expect(await fail()).toBe(401);
    expect(await fail()).toBe(429);
    await expect(auth.login("root", "password1", client)).rejects.toMatchObject({ status: 429 });
  });

  test("同時送出的猜測也只有 5 次會真的驗密碼", async () => {
    const statuses = await Promise.all(Array.from({ length: 20 }, () => fail()));
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(15);
  });

  test("鎖定時間指數增加，最長 15 分鐘", async () => {
    for (let i = 0; i < 5; i++) await fail();
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const err = await auth.login("root", "password1", client).catch((e) => e);
      const seconds = Number(err.headers["Retry-After"]);
      waits.push(seconds);
      t += seconds * 1000; // 等到解鎖，再失敗一次讓鎖定加倍
      if (i < 5) expect(await fail()).toBe(401);
    }
    expect(waits).toEqual([30, 60, 120, 240, 480, 900]);
  });

  test("鎖定只影響同一個 IP＋帳號", async () => {
    for (let i = 0; i < 5; i++) await fail();
    expect(await fail()).toBe(429);
    expect(await fail("10.9.9.9")).toBe(401);
    await auth.createUser("bob", "password1", "user");
    expect(await fail(client.ip, "bob")).toBe(401);
  });

  test("成功登入會清除失敗計數", async () => {
    for (let i = 0; i < 4; i++) await fail();
    await auth.login("root", "password1", client);
    for (let i = 0; i < 4; i++) expect(await fail()).toBe(401);
  });

  test("鎖定到期後可再嘗試", async () => {
    for (let i = 0; i < 5; i++) await fail();
    t += 31_000;
    await auth.login("root", "password1", client);
  });

  test("帳號不分大小寫", async () => {
    const r = await auth.login("ROOT", "password1", client);
    expect(r.user.username).toBe("root");
  });
});

describe("API token", () => {
  test("格式、只存雜湊、記錄最後使用時間、可撤銷", async () => {
    const { user } = await auth.setup("root", "password1", client);
    const created = auth.createToken(user.id, "Home Assistant");
    expect(created.token.startsWith("cnvr_")).toBe(true);
    expect(created.token.startsWith(created.prefix)).toBe(true);
    const stored = db.query("SELECT token_hash FROM api_tokens").get() as { token_hash: string };
    expect(stored.token_hash).not.toContain(created.token);
    expect(auth.listTokens(user.id)[0]?.lastUsedAt).toBeNull();

    const headers = { authorization: `Bearer ${created.token}` };
    expect(authenticate(headers)).toMatchObject({ username: "root", role: "admin", via: "token" });
    expect(auth.listTokens(user.id)[0]?.lastUsedAt).toBe(t);

    expect(auth.revokeToken(user.id, created.id)).toBe(true);
    expect(authenticate(headers)).toBeNull();
  });

  test("繼承建立者角色", async () => {
    await auth.setup("root", "password1", client);
    const bob = await auth.createUser("bob", "password1", "user");
    const tok = auth.createToken(bob.id, "tv");
    expect(authenticate({ authorization: `Bearer ${tok.token}` })?.role).toBe("user");
  });

  test("?token= 只接受 GET；Bearer 無效時不退回 cookie", async () => {
    const { user, sessionToken } = await auth.setup("root", "password1", client);
    const tok = auth.createToken(user.id, "x");
    expect(authenticate({}, `/api/cameras?token=${tok.token}`)?.via).toBe("token");
    expect(authenticate({}, `/api/cameras?token=${tok.token}`, "POST")).toBeNull();
    expect(authenticate({ authorization: "Bearer cnvr_bogus", ...cookie(sessionToken) })).toBeNull();
    expect(authenticate({ authorization: "Bearer " + sessionToken })).toBeNull();
  });

  test("刪除使用者連帶移除 token 與 session", async () => {
    await auth.setup("root", "password1", client);
    const bob = await auth.createUser("bob", "password1", "user");
    const tok = auth.createToken(bob.id, "x");
    const s = await auth.login("bob", "password1", client);
    auth.removeUser(bob.id);
    expect(authenticate({ authorization: `Bearer ${tok.token}` })).toBeNull();
    expect(authenticate(cookie(s.sessionToken))).toBeNull();
  });
});

describe("verifyCredentials", () => {
  test("接受密碼或對應帳號的 token", async () => {
    const { user } = await auth.setup("root", "password1", client);
    const tok = auth.createToken(user.id, "rtsp");
    expect(await auth.verifyCredentials("root", "password1")).toMatchObject({ userId: user.id });
    expect(await auth.verifyCredentials("root", tok.token)).toMatchObject({ userId: user.id, via: "token" });
    expect(await auth.verifyCredentials("root", "nope-nope")).toBeNull();
    expect(await auth.verifyCredentials("someone", tok.token)).toBeNull();
    expect(await auth.verifyCredentials("nobody", "password1")).toBeNull();
  });

  test("帶 ip 時失敗也會限流", async () => {
    await auth.setup("root", "password1", client);
    for (let i = 0; i < 5; i++) expect(await auth.verifyCredentials("root", "wrong-pass", "1.2.3.4")).toBeNull();
    expect(await auth.verifyCredentials("root", "password1", "1.2.3.4")).toBeNull();
    expect(await auth.verifyCredentials("root", "password1", "5.6.7.8")).not.toBeNull();
  });
});

describe("使用者管理", () => {
  test("最後一位管理員不能被刪除或降級", async () => {
    const { user } = await auth.setup("root", "password1", client);
    await expect(auth.updateUser(user.id, { role: "user" })).rejects.toMatchObject({ status: 409 });
    expect(() => auth.removeUser(user.id)).toThrow(expect.objectContaining({ status: 409 }));

    const second = await auth.createUser("admin2", "password1", "admin");
    await auth.updateUser(user.id, { role: "user" });
    expect(() => auth.removeUser(second.id)).toThrow(expect.objectContaining({ status: 409 }));
    auth.removeUser(user.id);
  });

  test("重複帳號回 409，重設密碼會登出該使用者所有 session", async () => {
    await auth.setup("root", "password1", client);
    await expect(auth.createUser("ROOT", "password1", "user")).rejects.toMatchObject({ status: 409 });
    const bob = await auth.createUser("bob", "password1", "user");
    const s = await auth.login("bob", "password1", client);
    await auth.updateUser(bob.id, { password: "reset-pass1" });
    expect(authenticate(cookie(s.sessionToken))).toBeNull();
    await auth.login("bob", "reset-pass1", client);
  });

  test("找不到的使用者回 404", async () => {
    await expect(auth.updateUser(99, { role: "user" })).rejects.toMatchObject({ status: 404 });
    expect(() => auth.removeUser(99)).toThrow(expect.objectContaining({ status: 404 }));
  });
});
