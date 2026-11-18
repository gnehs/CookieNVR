export interface PageCtx {
  params: Record<string, string>;
  query: URLSearchParams;
  /** 離開頁面時自動清除 */
  onCleanup(fn: () => void): void;
  /** 頁面可見時每 ms 執行一次，離開頁面自動停止 */
  every(ms: number, fn: () => void): void;
  isCurrent(): boolean;
}

export type Page = (ctx: PageCtx) => Node | Promise<Node>;

export interface Route {
  pattern: string;
  page: Page;
  access: "public" | "user" | "admin";
  /** 頁籤高亮用的導覽區塊 */
  section?: "cameras" | "recordings" | "settings" | "account";
}

export function parseHash(): { path: string; query: URLSearchParams } {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path = "/", qs = ""] = raw.split("?");
  return { path, query: new URLSearchParams(qs) };
}

export function navigate(path: string, replace = false) {
  const target = `#${path}`;
  if (location.hash === target) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  if (replace) location.replace(target);
  else location.hash = target;
}

export function matchRoute(routes: Route[], path: string): { route: Route; params: Record<string, string> } | null {
  const segs = path.split("/").filter(Boolean);
  for (const route of routes) {
    const pat = route.pattern.split("/").filter(Boolean);
    if (pat.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pat.length; i++) {
      const p = pat[i]!;
      const s = segs[i]!;
      if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(s);
      else if (p !== s) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}
