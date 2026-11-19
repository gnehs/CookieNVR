import type { LinkCreatedDto, LinkPollDto, LinkRequestDto, LinkStatus } from "../api-types.ts";
import { HttpError } from "../http/errors.ts";
import type { Principal } from "../types.ts";
import type { Auth } from "./auth.ts";

/**
 * 授權連結：仿 OAuth 2.0 裝置授權（RFC 8628）。App 建立請求拿到短碼與輪詢憑證，
 * 使用者在已登入的網頁上核准，App 用輪詢憑證取回以核准者身分建立的 API Token。
 *
 * 狀態轉移：pending →（核准）approved →（取走）claimed；pending →（拒絕）denied；
 * pending／approved 到期後一律視為 expired。Token 在取走當下才建立，核准後沒人來取就不會多一顆 token
 *（取走的回應若在網路上遺失，token 已建立但 App 沒收到，它會留在「連接其他 App」裡可撤銷）。
 */

export const LINK_TTL_MS = 10 * 60_000;
/** 結束後的請求再留這麼久，讓輪詢拿到明確的狀態而不是「找不到」 */
const RETAIN_MS = 10 * 60_000;
const POLL_INTERVAL_S = 2;

// 短碼：RFC 8628 §6.1 建議的 20 個子音字母（不含母音避免拼出字、不含易混淆字），8 碼約 34.6 bits
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const CODE_LENGTH = 8;

const LIMITS = {
  /** 每個 IP 每 10 分鐘最多建立幾筆 */
  createPerIp: { limit: 10, windowMs: 10 * 60_000 },
  /** 每個 IP 同時待核准的上限 */
  pendingPerIp: 5,
  /** 同時待核准的上限（全體） */
  pendingTotal: 100,
  /** 記憶體中最多保留幾筆（含已結束、保留中的），避免被灌爆 */
  total: 1000,
  /** 每個 IP 每分鐘輪詢次數 */
  pollPerIp: { limit: 90, windowMs: 60_000 },
  /** 每個 IP 用錯輪詢憑證的次數 */
  badPollPerIp: { limit: 20, windowMs: 10 * 60_000 },
  /** 每位使用者查不到短碼的次數（擋登入者猜短碼） */
  badCodePerUser: { limit: 10, windowMs: 10 * 60_000 },
} as const;

type LinkState =
  | { kind: "pending" }
  | { kind: "approved"; userId: number }
  | { kind: "denied" }
  | { kind: "claimed" };

interface LinkRequest {
  code: string;
  pollHash: string;
  app: string;
  ip: string;
  createdAt: number;
  expiresAt: number;
  state: LinkState;
}

export type LinkDecision = "approve" | "deny";

export interface LinkService {
  create(input: { app: string; ip: string; origin: string }): LinkCreatedDto;
  poll(pollSecret: string, ip: string): LinkPollDto;
  view(rawCode: string, principal: Principal): LinkRequestDto;
  decide(rawCode: string, principal: Principal, decision: LinkDecision): LinkRequestDto;
}

export type LinkTokens = Pick<Auth, "createToken" | "getUser">;

function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/** 拒絕取樣避免偏差：256 % 20 = 16，丟掉 240 以上的值 */
function randomCode(): string {
  let out = "";
  while (out.length < CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 240 && out.length < CODE_LENGTH) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return out;
}

export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** 接受大小寫與任何分隔符號；不合格式回 null */
export function normalizeCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[^A-Z]/g, "");
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

function windowLimiter(now: () => number, opts: { limit: number; windowMs: number }) {
  const hits = new Map<string, number[]>();
  const fresh = (key: string) => {
    const t = now();
    const list = (hits.get(key) ?? []).filter((at) => t - at < opts.windowMs);
    if (list.length === 0) hits.delete(key);
    else hits.set(key, list);
    return list;
  };
  return {
    /** 已達上限時回傳要等多久（毫秒），否則 0 */
    retryAfterMs(key: string): number {
      const list = fresh(key);
      return list.length < opts.limit ? 0 : Math.max(1, list[0]! + opts.windowMs - now());
    },
    record(key: string): void {
      const list = fresh(key);
      list.push(now());
      hits.set(key, list);
      if (hits.size > 10_000) for (const k of [...hits.keys()]) fresh(k);
    },
  };
}

function tooMany(waitMs: number, message: string): HttpError {
  return new HttpError(429, message, { "Retry-After": String(Math.ceil(waitMs / 1000)) });
}

export function createLinkService(opts: { tokens: LinkTokens; now?: () => number }): LinkService {
  const now = opts.now ?? Date.now;
  const byCode = new Map<string, LinkRequest>();
  const byPoll = new Map<string, LinkRequest>();
  const createLimit = windowLimiter(now, LIMITS.createPerIp);
  const pollLimit = windowLimiter(now, LIMITS.pollPerIp);
  const badPollLimit = windowLimiter(now, LIMITS.badPollPerIp);
  const badCodeLimit = windowLimiter(now, LIMITS.badCodePerUser);

  function statusOf(req: LinkRequest): LinkStatus {
    const expired = now() >= req.expiresAt;
    switch (req.state.kind) {
      case "pending":
        return expired ? "expired" : "pending";
      case "approved":
        return expired ? "expired" : "approved";
      case "denied":
        return "denied";
      case "claimed":
        return "claimed";
    }
  }

  function prune() {
    const t = now();
    for (const req of byCode.values()) {
      if (t >= req.expiresAt + RETAIN_MS) {
        byCode.delete(req.code);
        byPoll.delete(req.pollHash);
      }
    }
  }

  function toDto(req: LinkRequest): LinkRequestDto {
    return {
      code: formatCode(req.code),
      app: req.app,
      ip: req.ip,
      createdAt: req.createdAt,
      expiresAt: req.expiresAt,
      expiresIn: Math.max(0, Math.round((req.expiresAt - now()) / 1000)),
      status: statusOf(req),
    };
  }

  function lookup(rawCode: string, principal: Principal): LinkRequest {
    const key = String(principal.userId);
    const wait = badCodeLimit.retryAfterMs(key);
    if (wait > 0) throw tooMany(wait, "嘗試太多次了，請稍後再試");
    prune();
    const code = normalizeCode(rawCode);
    const req = code === null ? undefined : byCode.get(code);
    if (!req) {
      badCodeLimit.record(key);
      throw new HttpError(404, "找不到這個連結請求，請確認代碼，或回到 App 重新開始");
    }
    return req;
  }

  function claim(req: LinkRequest, userId: number): LinkPollDto {
    req.state = { kind: "claimed" };
    const user = opts.tokens.getUser(userId);
    // 核准後、取走前帳號被刪除：不發 token
    if (!user) return { status: "denied" };
    const day = new Date(req.createdAt).toISOString().slice(0, 10);
    const created = opts.tokens.createToken(user.id, `${req.app}（${req.ip}，${day}）`);
    return { status: "approved", token: created.token, username: user.username, role: user.role };
  }

  return {
    create({ app, ip, origin }) {
      prune();
      const wait = createLimit.retryAfterMs(ip);
      if (wait > 0) throw tooMany(wait, "建立連結請求太頻繁，請稍後再試");
      const pendingFromIp = [...byCode.values()].filter((r) => r.ip === ip && statusOf(r) === "pending").length;
      if (pendingFromIp >= LIMITS.pendingPerIp) throw tooMany(LINK_TTL_MS, "待核准的連結請求太多，請先完成或等它們過期");
      const pendingAll = [...byCode.values()].filter((r) => statusOf(r) === "pending").length;
      if (pendingAll >= LIMITS.pendingTotal || byCode.size >= LIMITS.total) {
        throw tooMany(RETAIN_MS, "目前有太多連結請求，請稍後再試");
      }
      createLimit.record(ip);

      let code = randomCode();
      while (byCode.has(code)) code = randomCode();
      const pollSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
      const t = now();
      const req: LinkRequest = {
        code,
        pollHash: sha256Hex(pollSecret),
        app,
        ip,
        createdAt: t,
        expiresAt: t + LINK_TTL_MS,
        state: { kind: "pending" },
      };
      byCode.set(code, req);
      byPoll.set(req.pollHash, req);
      return {
        code: formatCode(code),
        approveUrl: `${origin}/#/link/${formatCode(code)}`,
        pollSecret,
        expiresAt: req.expiresAt,
        expiresIn: LINK_TTL_MS / 1000,
        interval: POLL_INTERVAL_S,
      };
    },

    poll(pollSecret, ip) {
      const wait = Math.max(pollLimit.retryAfterMs(ip), badPollLimit.retryAfterMs(ip));
      if (wait > 0) throw tooMany(wait, "輪詢太頻繁，請稍後再試");
      pollLimit.record(ip);
      prune();
      const req = byPoll.get(sha256Hex(pollSecret));
      if (!req) {
        badPollLimit.record(ip);
        throw new HttpError(404, "找不到這個連結請求，可能已過期");
      }
      const status = statusOf(req);
      if (status === "approved" && req.state.kind === "approved") return claim(req, req.state.userId);
      return { status: status === "approved" ? "expired" : status };
    },

    view(rawCode, principal) {
      return toDto(lookup(rawCode, principal));
    },

    decide(rawCode, principal, decision) {
      const req = lookup(rawCode, principal);
      const status = statusOf(req);
      if (status === "expired") throw new HttpError(410, "這個請求已經過期，請回到 App 重新開始");
      if (status !== "pending") throw new HttpError(409, "這個請求已經處理過了");
      req.state = decision === "approve" ? { kind: "approved", userId: principal.userId } : { kind: "denied" };
      return toDto(req);
    },
  };
}
