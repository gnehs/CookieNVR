import type { LinkProofDto } from "../api-types.ts";
import type { LinkService } from "../auth/link.ts";
import type { Principal, Route, RouteContext } from "../types.ts";
import { isSecure } from "./auth-routes.ts";
import { HttpError } from "./errors.ts";
import { json } from "./respond.ts";
import { asObject, oneOf, readJson, str } from "./validate.ts";
import { msg } from "../messages/index.ts";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * 核准會發出 token，只接受瀏覽器裡、同源頁面上的登入者：
 * 拒絕 API Token（App 不能替自己核准），並以 Fetch Metadata（舊瀏覽器退回 Origin）擋跨站請求。
 */
function approver(ctx: RouteContext): Principal {
  const p = ctx.principal;
  if (!p) throw new HttpError(401, msg("http.loginRequired"));
  if (p.via !== "session") throw new HttpError(403, msg("link.useWebLogin"));
  const site = ctx.req.headers.get("sec-fetch-site");
  if (site !== null) {
    if (site !== "same-origin") throw new HttpError(403, msg("link.useWebDirect"));
    return p;
  }
  const origin = ctx.req.headers.get("origin");
  let host: string | null = null;
  try {
    host = origin ? new URL(origin).host : null;
  } catch {}
  if (host === null || host !== ctx.url.host) throw new HttpError(403, msg("link.useWebDirect"));
  return p;
}

export function linkRoutes(
  links: LinkService,
  proof: { proveToken: (lookup: string, message: string) => string | null; instanceId: string },
): Route[] {
  return [
    {
      method: "POST",
      path: "/api/link/proof",
      access: "public",
      async handler(ctx) {
        const body = asObject(await readJson(ctx.req));
        const lookup = str(body, "lookup", { max: 64 });
        const nonce = str(body, "nonce", { max: 128 });
        // 訊息綁上實例識別碼，答案不能拿去冒充別台
        const answer = proof.proveToken(lookup, `${nonce}|${proof.instanceId}`);
        if (answer === null) throw new HttpError(404, msg("link.connectionNotFound"));
        return json({ proof: answer } satisfies LinkProofDto, 200, NO_STORE);
      },
    },
    {
      method: "POST",
      path: "/api/link",
      access: "public",
      async handler(ctx) {
        const body = asObject(await readJson(ctx.req));
        const app = str(body, "app", { max: 40 }).trim();
        if (/\p{C}/u.test(app)) throw new HttpError(400, msg("field.noControlChars", { path: "app" }));
        const origin = `${isSecure(ctx) ? "https" : "http"}://${ctx.url.host}`;
        // 雙協定堆疊的 socket 會把 IPv4 寫成 ::ffff:a.b.c.d，給人看的名稱用原本的樣子
        const ip = ctx.ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
        return json(links.create({ app, ip, origin }), 201, NO_STORE);
      },
    },
    {
      method: "POST",
      path: "/api/link/poll",
      access: "public",
      async handler(ctx) {
        const body = asObject(await readJson(ctx.req));
        return json(links.poll(str(body, "pollSecret", { max: 128 }), ctx.ip), 200, NO_STORE);
      },
    },
    {
      method: "GET",
      path: "/api/link/:code",
      access: "user",
      handler(ctx) {
        if (!ctx.principal) throw new HttpError(401, msg("http.loginRequired"));
        return json(links.view(ctx.params.code ?? "", ctx.principal), 200, NO_STORE);
      },
    },
    {
      method: "POST",
      path: "/api/link/:code",
      access: "user",
      async handler(ctx) {
        const p = approver(ctx);
        const body = asObject(await readJson(ctx.req));
        const decision = oneOf(body, "decision", ["approve", "deny"] as const);
        return json(links.decide(ctx.params.code ?? "", p, decision), 200, NO_STORE);
      },
    },
  ];
}
