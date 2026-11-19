import type { Route, RouteAccess } from "../types.ts";
import type { Auth } from "../auth/index.ts";
import { HttpError } from "./errors.ts";
import { errorResponse, toErrorResponse } from "./respond.ts";

export interface ServerLike {
  requestIP(req: Request): { address: string } | null;
}

export interface RouterOptions {
  /** 沒有任何路由符合時呼叫（例如提供前端靜態檔） */
  fallback?: (req: Request) => Response | Promise<Response>;
}

interface Compiled {
  route: Route;
  segments: string[];
  paramCount: number;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const BODY_METHODS = new Set(["POST", "PUT", "DELETE"]);

function compile(route: Route): Compiled {
  const segments = route.path.split("/").filter(Boolean);
  return { route, segments, paramCount: segments.filter((s) => s.startsWith(":")).length };
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    const a = actual[i]!;
    if (p.startsWith(":")) {
      try {
        params[p.slice(1)] = decodeURIComponent(a);
      } catch {
        throw new HttpError(400, "網址格式錯誤");
      }
    } else if (p !== a) {
      return null;
    }
  }
  return params;
}

const contentType = (req: Request) => req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();

export function createRouter(
  routes: Route[],
  auth: Pick<Auth, "authenticate">,
  options: RouterOptions = {},
): (req: Request, server?: ServerLike | null) => Promise<Response> {
  // 靜態段優先於參數段，例如 /cameras/test 先於 /cameras/:id
  const compiled = routes.map(compile).sort((a, b) => a.paramCount - b.paramCount);

  async function dispatch(req: Request, server: ServerLike | null | undefined): Promise<Response> {
    const url = new URL(req.url);
    const actual = url.pathname.split("/").filter(Boolean);
    const allowed = new Set<string>();
    let hit: { c: Compiled; params: Record<string, string> } | null = null;

    for (const c of compiled) {
      const params = matchSegments(c.segments, actual);
      if (!params) continue;
      allowed.add(c.route.method);
      if (!hit && c.route.method === req.method) hit = { c, params };
    }

    if (!hit) {
      if (allowed.size > 0) {
        return errorResponse(405, "不支援的請求方法", { Allow: [...allowed].join(", ") });
      }
      return options.fallback ? options.fallback(req) : errorResponse(404, "找不到資源");
    }

    const { route } = hit.c;
    const ip = server?.requestIP(req)?.address ?? "unknown";
    const access: RouteAccess = route.access;

    if (access === "internal") {
      // 反向代理在本機時對外請求的來源也是 127.0.0.1，靠 forwarding 標頭排除
      const proxied = req.headers.has("x-forwarded-for") || req.headers.has("forwarded");
      if (!LOOPBACK.has(ip) || proxied) return errorResponse(403, "禁止存取");
    }

    const principal = access === "user" || access === "admin" ? auth.authenticate(req, url) : null;
    if ((access === "user" || access === "admin") && !principal) return errorResponse(401, "請先登入");
    if (access === "admin" && principal?.role !== "admin") return errorResponse(403, "需要管理員權限");

    // HTML 表單送不出 application/json 或 zip：只收這些類型，跨站請求就偽造不了
    const type = contentType(req);
    if (BODY_METHODS.has(req.method) && req.body !== null && type !== "application/json" && !(type && route.accepts?.includes(type))) {
      return errorResponse(415, `請求的 Content-Type 必須是 ${route.accepts?.join("、") ?? "application/json"}`);
    }

    return route.handler({ req, url, params: hit.params, principal, ip });
  }

  return async (req, server) => {
    try {
      return await dispatch(req, server);
    } catch (err) {
      return toErrorResponse(err);
    }
  };
}
