import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { errorResponse } from "./respond.ts";

/** Vite 輸出的檔名帶內容雜湊，可以永久快取；index.html 每次都要重新驗證，部署新版才拿得到新的雜湊檔名 */
const IMMUTABLE = "public, max-age=31536000, immutable";

const MISSING = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>CookieNVR</title>
<body style="font-family:system-ui;padding:32px;line-height:1.6">
<h1 style="font-size:20px">網頁介面還沒有建置</h1>
<p>在專案目錄執行 <code>bun run build</code> 後重新整理；開發時改用 <code>bun run dev:web</code> 開啟的網址。API 照常運作。</p>`;

/**
 * 提供 `vite build` 的產物（單頁應用）：檔案存在就直接給，其他路徑一律回 index.html，交給前端路由。
 * `/assets/` 底下找不到的檔案回 404，免得舊版頁面要舊的雜湊檔時拿到 HTML。
 */
export function webApp(dir: string): { ready: boolean; handle: (req: Request) => Promise<Response> } {
  const root = resolve(dir);
  const ready = existsSync(join(root, "index.html"));

  async function handle(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/api" || pathname.startsWith("/api/") || pathname.startsWith("/internal/")) return errorResponse(404, "找不到資源");
    if (req.method !== "GET" && req.method !== "HEAD") return errorResponse(405, "不支援的請求方法", { Allow: "GET, HEAD" });
    if (!ready) return new Response(MISSING, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

    let file: string | null = null;
    try {
      file = resolve(root, `.${decodeURIComponent(pathname)}`);
    } catch {
      return errorResponse(400, "網址格式錯誤");
    }
    if (file.startsWith(root + sep) && !file.endsWith(`${sep}index.html`)) {
      const f = Bun.file(file);
      if (await f.exists()) {
        const hashed = file.startsWith(join(root, "assets") + sep);
        return new Response(f, { headers: { "cache-control": hashed ? IMMUTABLE : "no-cache" } });
      }
    }
    if (pathname.startsWith("/assets/")) return errorResponse(404, "找不到資源");
    return new Response(Bun.file(join(root, "index.html")), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  }

  return { ready, handle };
}
