import type { Database } from "bun:sqlite";
import type { MeDto, SessionDto, TokenDto, UserDto, CreatedTokenDto } from "../api-types.ts";
import type { Principal, Role } from "../types.ts";
import { HttpError } from "../http/errors.ts";
import { createLoginLimiter } from "./rate-limit.ts";
import { msg } from "../messages/index.ts";

export const SESSION_COOKIE = "cnvr_session";
export const TOKEN_PREFIX = "cnvr_";
export const MIN_PASSWORD_LENGTH = 8;

const MAX_PASSWORD_LENGTH = 256;
const SESSION_TTL_MS = 30 * 24 * 3600_000;
// 寫入頻率上限：避免每個請求都更新資料庫
const TOUCH_INTERVAL_MS = 60_000;

export interface ClientInfo {
  ip: string;
  userAgent: string;
}

export interface LoginResult {
  user: MeDto;
  /** 只在發出當下可見，資料庫只存雜湊 */
  sessionToken: string;
}

export interface UserPatch {
  role?: Role;
  password?: string;
}

export interface Auth {
  needsSetup(): boolean;
  setup(username: string, password: string, client: ClientInfo): Promise<LoginResult>;
  login(username: string, password: string, client: ClientInfo): Promise<LoginResult>;
  logout(sessionToken: string): void;
  /** Cookie、Bearer、`?token=`（僅 GET）任一通過即回傳身分 */
  authenticate(req: Request, url: URL): Principal | null;
  /** RTSP 轉發驗證用：secret 可以是密碼或 API Token */
  verifyCredentials(username: string, secret: string, ip?: string): Promise<Principal | null>;
  sessionTokenOf(req: Request): string | null;
  sessionIdOf(sessionToken: string): string;
  sessionCookie(sessionToken: string, secure: boolean): string;
  clearSessionCookie(secure: boolean): string;

  changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
    keepSessionId: string | null,
  ): Promise<void>;
  listSessions(userId: number, currentSessionId: string | null): SessionDto[];
  revokeSession(userId: number, sessionId: string): boolean;

  listTokens(userId: number): TokenDto[];
  createToken(userId: number, name: string): CreatedTokenDto;
  revokeToken(userId: number, tokenId: number): boolean;
  /**
   * 不送出 token 也能證明「我是發這個 token 的那台 NVR」：key 是 token 的 SHA-256（資料庫存的就是它），
   * `lookup` 是 `sha256("cnvr-proof-id:" + key)`，回傳 `HMAC-SHA256(key, message)`；找不到回 null。
   */
  proveToken(lookup: string, message: string): string | null;

  getUser(id: number): UserDto | null;
  listUsers(): UserDto[];
  createUser(username: string, password: string, role: Role): Promise<UserDto>;
  updateUser(id: number, patch: UserPatch): Promise<UserDto>;
  removeUser(id: number): void;
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  created_at: number;
  last_login_at: number | null;
}

function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export function validateUsername(raw: string): string {
  const username = raw.trim();
  if (username.length < 1 || username.length > 64 || /\p{C}/u.test(username)) {
    throw new HttpError(400, msg("auth.usernameInvalid"));
  }
  return username;
}

export function validatePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, msg("auth.passwordTooShort", { min: MIN_PASSWORD_LENGTH }));
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(400, msg("auth.passwordTooLong", { max: MAX_PASSWORD_LENGTH }));
  }
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

export function createAuth(opts: { db: Database; now?: () => number }): Auth {
  const { db } = opts;
  const now = opts.now ?? Date.now;
  const limiter = createLoginLimiter(now);

  // 帳號不存在時也要做一次雜湊驗證，避免用回應時間探測帳號
  let dummyHash: Promise<string> | null = null;
  const getDummyHash = () => (dummyHash ??= Bun.password.hash("cookienvr-dummy", "argon2id"));

  const hashPassword = (password: string) => Bun.password.hash(password, "argon2id");

  function userByName(username: string): UserRow | null {
    return db.query("SELECT * FROM users WHERE username = ?").get(username) as UserRow | null;
  }

  function userById(id: number): UserRow | null {
    return db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow | null;
  }

  async function checkPassword(username: string, password: string): Promise<UserRow | null> {
    const user = userByName(username);
    if (!user) {
      await Bun.password.verify(password, await getDummyHash()).catch(() => false);
      return null;
    }
    const ok = await Bun.password.verify(password, user.password_hash).catch(() => false);
    return ok ? user : null;
  }

  function createSession(userId: number, client: ClientInfo): string {
    const token = randomToken();
    const t = now();
    db.query("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").run(userId, t);
    db.query(
      "INSERT INTO sessions (id, user_id, expires_at, last_seen_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(sha256Hex(token), userId, t + SESSION_TTL_MS, t, client.userAgent.slice(0, 256), client.ip);
    return token;
  }

  function principalOf(row: { id: number; username: string; role: Role }, via: Principal["via"]): Principal {
    return { userId: row.id, username: row.username, role: row.role, via };
  }

  function sessionPrincipal(sessionToken: string): Principal | null {
    const id = sha256Hex(sessionToken);
    const row = db
      .query(
        `SELECT s.expires_at, s.last_seen_at, u.id, u.username, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      )
      .get(id) as { expires_at: number; last_seen_at: number; id: number; username: string; role: Role } | null;
    if (!row) return null;
    const t = now();
    if (row.expires_at <= t) {
      db.query("DELETE FROM sessions WHERE id = ?").run(id);
      return null;
    }
    if (t - row.last_seen_at >= TOUCH_INTERVAL_MS) {
      db.query("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(t, t + SESSION_TTL_MS, id);
    }
    return principalOf(row, "session");
  }

  function tokenPrincipal(token: string): Principal | null {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const row = db
      .query(
        `SELECT t.id AS token_id, t.last_used_at, u.id, u.username, u.role
         FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
      )
      .get(sha256Hex(token)) as
      | { token_id: number; last_used_at: number | null; id: number; username: string; role: Role }
      | null;
    if (!row) return null;
    const t = now();
    if (row.last_used_at === null || t - row.last_used_at >= TOUCH_INTERVAL_MS) {
      db.query("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(t, row.token_id);
    }
    return principalOf(row, "token");
  }

  function adminCount(): number {
    return (db.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n;
  }

  function insertUser(username: string, passwordHash: string, role: Role, onlyIfEmpty: boolean): UserRow {
    try {
      return db.transaction(() => {
        if (onlyIfEmpty) {
          const n = (db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
          if (n > 0) throw new HttpError(409, msg("auth.setupDone"));
        }
        return db
          .query("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?) RETURNING *")
          .get(username, passwordHash, role, now()) as UserRow;
      })();
    } catch (err) {
      if (err instanceof Error && /UNIQUE/i.test(err.message)) throw new HttpError(409, msg("auth.usernameTaken"));
      throw err;
    }
  }

  function needsSetup(): boolean {
    return (db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n === 0;
  }

  function limiterKey(ip: string, username: string): string {
    return `${ip}|${username.toLowerCase()}`;
  }

  async function startSession(user: UserRow, client: ClientInfo): Promise<LoginResult> {
    db.query("UPDATE users SET last_login_at = ? WHERE id = ?").run(now(), user.id);
    return {
      user: { id: user.id, username: user.username, role: user.role },
      sessionToken: createSession(user.id, client),
    };
  }

  return {
    needsSetup,

    async setup(rawUsername, password, client) {
      const username = validateUsername(rawUsername);
      validatePassword(password);
      if (!needsSetup()) throw new HttpError(409, msg("auth.setupDone"));
      const user = insertUser(username, await hashPassword(password), "admin", true);
      return startSession(user, client);
    },

    async login(rawUsername, password, client) {
      const username = rawUsername.trim();
      const key = limiterKey(client.ip, username);
      const wait = limiter.retryAfterMs(key);
      if (wait > 0) {
        throw new HttpError(429, msg("auth.tooManyLogins"), {
          "Retry-After": String(Math.ceil(wait / 1000)),
        });
      }
      const user = await checkPassword(username, password);
      if (!user) {
        limiter.recordFailure(key);
        throw new HttpError(401, msg("auth.badCredentials"));
      }
      limiter.recordSuccess(key);
      return startSession(user, client);
    },

    logout(sessionToken) {
      db.query("DELETE FROM sessions WHERE id = ?").run(sha256Hex(sessionToken));
    },

    authenticate(req, url) {
      const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
      if (bearer?.[1]) return tokenPrincipal(bearer[1]);
      if (req.method === "GET") {
        const q = url.searchParams.get("token");
        if (q) return tokenPrincipal(q);
      }
      const cookie = readCookie(req, SESSION_COOKIE);
      return cookie ? sessionPrincipal(cookie) : null;
    },

    async verifyCredentials(username, secret, ip) {
      const key = ip === undefined ? null : limiterKey(ip, username);
      if (key !== null && limiter.retryAfterMs(key) > 0) return null;

      let principal: Principal | null = null;
      if (secret.startsWith(TOKEN_PREFIX)) {
        const p = tokenPrincipal(secret);
        if (p && p.username.toLowerCase() === username.toLowerCase()) principal = p;
      }
      if (!principal) {
        const user = await checkPassword(username, secret);
        if (user) principal = principalOf(user, "session");
      }

      if (key !== null) {
        if (principal) limiter.recordSuccess(key);
        else limiter.recordFailure(key);
      }
      return principal;
    },

    sessionTokenOf: (req) => readCookie(req, SESSION_COOKIE),
    sessionIdOf: sha256Hex,

    sessionCookie(sessionToken, secure) {
      const attrs = [
        `${SESSION_COOKIE}=${sessionToken}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${SESSION_TTL_MS / 1000}`,
      ];
      if (secure) attrs.push("Secure");
      return attrs.join("; ");
    },

    clearSessionCookie(secure) {
      const attrs = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
      if (secure) attrs.push("Secure");
      return attrs.join("; ");
    },

    async changePassword(userId, currentPassword, newPassword, keepSessionId) {
      validatePassword(newPassword);
      const user = userById(userId);
      if (!user || !(await Bun.password.verify(currentPassword, user.password_hash).catch(() => false))) {
        throw new HttpError(403, msg("auth.wrongCurrentPassword"));
      }
      const hash = await hashPassword(newPassword);
      db.transaction(() => {
        db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
        db.query("DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?").run(userId, keepSessionId);
      })();
    },

    listSessions(userId, currentSessionId) {
      const rows = db
        .query(
          "SELECT id, user_agent, ip, last_seen_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC",
        )
        .all(userId, now()) as { id: string; user_agent: string; ip: string; last_seen_at: number }[];
      return rows.map((r) => ({
        id: r.id,
        current: r.id === currentSessionId,
        userAgent: r.user_agent,
        ip: r.ip,
        lastSeenAt: r.last_seen_at,
      }));
    },

    revokeSession(userId, sessionId) {
      return db.query("DELETE FROM sessions WHERE id = ? AND user_id = ?").run(sessionId, userId).changes > 0;
    },

    listTokens(userId) {
      const rows = db
        .query("SELECT id, name, prefix, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id")
        .all(userId) as { id: number; name: string; prefix: string; created_at: number; last_used_at: number | null }[];
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
      }));
    },

    createToken(userId, rawName) {
      const name = rawName.trim();
      if (name.length < 1 || name.length > 100) throw new HttpError(400, msg("auth.nameLength"));
      const token = `${TOKEN_PREFIX}${randomToken()}`;
      const prefix = token.slice(0, TOKEN_PREFIX.length + 4);
      const createdAt = now();
      const row = db
        .query("INSERT INTO api_tokens (user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id")
        .get(userId, name, sha256Hex(token), prefix, createdAt) as { id: number };
      return { id: row.id, name, prefix, createdAt, lastUsedAt: null, token };
    },

    proveToken(lookup, message) {
      const rows = db.query("SELECT token_hash FROM api_tokens").all() as { token_hash: string }[];
      const row = rows.find((r) => sha256Hex(`cnvr-proof-id:${r.token_hash}`) === lookup);
      return row ? new Bun.CryptoHasher("sha256", row.token_hash).update(message).digest("hex") : null;
    },

    revokeToken(userId, tokenId) {
      return db.query("DELETE FROM api_tokens WHERE id = ? AND user_id = ?").run(tokenId, userId).changes > 0;
    },

    getUser(id) {
      const row = userById(id);
      return row ? toUserDto(row) : null;
    },

    listUsers() {
      return (db.query("SELECT * FROM users ORDER BY id").all() as UserRow[]).map(toUserDto);
    },

    async createUser(rawUsername, password, role) {
      const username = validateUsername(rawUsername);
      validatePassword(password);
      return toUserDto(insertUser(username, await hashPassword(password), role, false));
    },

    async updateUser(id, patch) {
      if (patch.password !== undefined) validatePassword(patch.password);
      const hash = patch.password === undefined ? null : await hashPassword(patch.password);
      return db.transaction(() => {
        const user = userById(id);
        if (!user) throw new HttpError(404, msg("auth.userNotFound"));
        if (patch.role !== undefined && patch.role !== user.role) {
          if (user.role === "admin" && adminCount() <= 1) throw new HttpError(409, msg("auth.lastAdmin"));
          db.query("UPDATE users SET role = ? WHERE id = ?").run(patch.role, id);
        }
        if (hash !== null) {
          db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, id);
          db.query("DELETE FROM sessions WHERE user_id = ?").run(id);
        }
        return toUserDto(userById(id)!);
      })();
    },

    removeUser(id) {
      db.transaction(() => {
        const user = userById(id);
        if (!user) throw new HttpError(404, msg("auth.userNotFound"));
        if (user.role === "admin" && adminCount() <= 1) throw new HttpError(409, msg("auth.lastAdmin"));
        db.query("DELETE FROM users WHERE id = ?").run(id);
      })();
    },
  };
}
