import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { api, DEMO_ADMIN } from "./dev-mock.ts";

interface RouteKey {
  method: string;
  path: string;
}

/** 真後端的路由宣告長這樣：`method: "GET", path: "/api/..."`（main.ts 有頂層副作用，不能匯入，所以靜態掃描） */
async function backendRoutes(): Promise<RouteKey[]> {
  const root = new URL("../src/", import.meta.url).pathname;
  const found = new Map<string, RouteKey>();
  for await (const file of new Glob("**/*.ts").scan(root)) {
    if (file.endsWith(".test.ts")) continue;
    const text = await Bun.file(root + file).text();
    for (const m of text.matchAll(/method:\s*"(GET|POST|PUT|PATCH|DELETE)",\s*path:\s*"(\/api\/[^"]*)"/g)) {
      found.set(`${m[1]} ${m[2]}`, { method: m[1]!, path: m[2]! });
    }
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** 真後端有、假後端刻意不做的路由，每條附原因 */
const UNSUPPORTED: Record<string, string> = {
  "GET /api/link/proof": "HA 整合用來驗證 instanceId 的簽章，假後端沒有可驗的金鑰",
};

const call = (method: string, path: string, cookie = "", payload?: unknown) =>
  api(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(payload ?? {}),
    }),
    new URL(`http://localhost${path}`),
  );

const isUnknownRoute = async (res: Response) => res.status === 404 && ((await res.clone().json().catch(() => null)) as { code?: string } | null)?.code === "http.notFound";

async function loginCookie(): Promise<string> {
  const res = await call("POST", "/api/auth/login", "", DEMO_ADMIN);
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

describe("dev mock", () => {
  test("handles every route the real backend declares, except the listed ones", async () => {
    const routes = await backendRoutes();
    expect(routes.length).toBeGreaterThan(50);
    const cookie = await loginCookie();

    const unhandled: string[] = [];
    const stale: string[] = [];
    await Promise.all(
      routes.map(async ({ method, path }) => {
        const key = `${method} ${path}`;
        if (key === "POST /api/auth/logout") return;
        let handled: boolean;
        try {
          handled = !(await isUnknownRoute(await call(method, path.replace(/:\w+/g, "1"), cookie)));
        } catch {
          handled = true;
        }
        if (key in UNSUPPORTED) {
          if (handled) stale.push(key);
        } else if (!handled) unhandled.push(key);
      }),
    );
    expect((await call("POST", "/api/auth/logout", cookie)).status).toBe(204);

    expect({ unhandled: unhandled.sort() }).toEqual({ unhandled: [] });
    expect({ stale: stale.sort() }).toEqual({ stale: [] });
  }, 60_000);

  test("answers an unknown path with the not-found error", async () => {
    const cookie = await loginCookie();
    expect(await isUnknownRoute(await call("GET", "/api/no-such-route", cookie))).toBe(true);
  });
});
