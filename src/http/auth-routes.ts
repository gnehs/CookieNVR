import { API_VERSION, type InfoDto } from "../api-types.ts";
import type { Auth, ClientInfo } from "../auth/index.ts";
import type { Principal, Route, RouteContext } from "../types.ts";
import { HttpError } from "./errors.ts";
import { json, noContent } from "./respond.ts";
import { asObject, parseIdParam, readJson, str } from "./validate.ts";

export function clientOf(ctx: RouteContext): ClientInfo {
  return { ip: ctx.ip, userAgent: ctx.req.headers.get("user-agent") ?? "" };
}

export function isSecure(ctx: RouteContext): boolean {
  return ctx.url.protocol === "https:" || ctx.req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
}

function me(ctx: RouteContext): Principal {
  if (!ctx.principal) throw new HttpError(401, "請先登入");
  return ctx.principal;
}

export function authRoutes(auth: Auth, version: string): Route[] {
  const credentials = async (ctx: RouteContext) => {
    const body = asObject(await readJson(ctx.req));
    return { username: str(body, "username", { max: 256 }), password: str(body, "password", { max: 1024, allowEmpty: true }) };
  };

  const withSession = (ctx: RouteContext, result: { user: unknown; sessionToken: string }) =>
    json(result.user, 200, { "Set-Cookie": auth.sessionCookie(result.sessionToken, isSecure(ctx)) });

  return [
    {
      method: "GET",
      path: "/api/info",
      access: "public",
      handler: () => json({ version, apiVersion: API_VERSION, needsSetup: auth.needsSetup() } satisfies InfoDto),
    },
    {
      method: "POST",
      path: "/api/auth/setup",
      access: "public",
      async handler(ctx) {
        const { username, password } = await credentials(ctx);
        return withSession(ctx, await auth.setup(username, password, clientOf(ctx)));
      },
    },
    {
      method: "POST",
      path: "/api/auth/login",
      access: "public",
      async handler(ctx) {
        const { username, password } = await credentials(ctx);
        return withSession(ctx, await auth.login(username, password, clientOf(ctx)));
      },
    },
    {
      method: "POST",
      path: "/api/auth/logout",
      access: "public",
      handler(ctx) {
        const token = auth.sessionTokenOf(ctx.req);
        if (token) auth.logout(token);
        return noContent({ "Set-Cookie": auth.clearSessionCookie(isSecure(ctx)) });
      },
    },
    {
      method: "GET",
      path: "/api/me",
      access: "user",
      handler(ctx) {
        const p = me(ctx);
        return json({ id: p.userId, username: p.username, role: p.role });
      },
    },
    {
      method: "PUT",
      path: "/api/me",
      access: "user",
      async handler(ctx) {
        const body = asObject(await readJson(ctx.req));
        const token = auth.sessionTokenOf(ctx.req);
        // 用 token 改密碼時沒有「目前的 session」，其餘 session 全部登出
        const keep = ctx.principal?.via === "session" && token ? auth.sessionIdOf(token) : null;
        await auth.changePassword(
          me(ctx).userId,
          str(body, "currentPassword", { max: 1024, allowEmpty: true }),
          str(body, "newPassword", { max: 1024, allowEmpty: true }),
          keep,
        );
        return noContent();
      },
    },
    {
      method: "GET",
      path: "/api/me/sessions",
      access: "user",
      handler(ctx) {
        const token = ctx.principal?.via === "session" ? auth.sessionTokenOf(ctx.req) : null;
        return json(auth.listSessions(me(ctx).userId, token ? auth.sessionIdOf(token) : null));
      },
    },
    {
      method: "DELETE",
      path: "/api/me/sessions/:id",
      access: "user",
      handler(ctx) {
        if (!auth.revokeSession(me(ctx).userId, ctx.params.id ?? "")) throw new HttpError(404, "找不到登入裝置");
        const token = auth.sessionTokenOf(ctx.req);
        const revokedCurrent = token !== null && auth.sessionIdOf(token) === ctx.params.id;
        return noContent(revokedCurrent ? { "Set-Cookie": auth.clearSessionCookie(isSecure(ctx)) } : undefined);
      },
    },
    {
      method: "GET",
      path: "/api/tokens",
      access: "user",
      handler: (ctx) => json(auth.listTokens(me(ctx).userId)),
    },
    {
      method: "POST",
      path: "/api/tokens",
      access: "user",
      async handler(ctx) {
        const body = asObject(await readJson(ctx.req));
        return json(auth.createToken(me(ctx).userId, str(body, "name", { max: 1024 })), 201);
      },
    },
    {
      method: "DELETE",
      path: "/api/tokens/:id",
      access: "user",
      handler(ctx) {
        const id = parseIdParam(ctx.params.id);
        if (id === null || !auth.revokeToken(me(ctx).userId, id)) throw new HttpError(404, "找不到 Token");
        return noContent();
      },
    },
  ];
}
