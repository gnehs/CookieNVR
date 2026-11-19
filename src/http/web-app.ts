import { existsSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { errorResponse } from "./respond.ts";

/** Vite 輸出的檔名帶內容雜湊，可以永久快取；index.html 每次都要重新驗證，部署新版才拿得到新的雜湊檔名 */
const IMMUTABLE = "public, max-age=31536000, immutable";

const MISSING = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>CookieNVR</title>
<body style="font-family:system-ui;padding:32px;line-height:1.6">
<h1 style="font-size:20px">網頁介面還沒有建置</h1>
<p>在專案目錄執行 <code>bun run build</code> 後重新整理；開發時改用 <code>bun run dev:web</code> 開啟的網址。API 照常運作。</p>`;

/** `vite build` 替文字檔預先產生的壓縮版本，依偏好順序 */
const ENCODINGS = [
  { name: "br", ext: ".br" },
  { name: "gzip", ext: ".gz" },
] as const;

/** Accept-Encoding 裡可以用的編碼（q=0 表示拒絕） */
function acceptedEncodings(header: string | null): Set<string> {
  const out = new Set<string>();
  for (const part of (header ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (name && !(q && Number(q.slice(2)) === 0)) out.add(name);
  }
  return out;
}

/**
 * 提供 `vite build` 的產物（單頁應用）：檔案存在就直接給，其他路徑一律回 index.html，交給前端路由。
 * `/assets/` 底下找不到的檔案回 404，免得舊版頁面要舊的雜湊檔時拿到 HTML。
 */
export function webApp(dir: string): { ready: boolean; handle: (req: Request) => Promise<Response> } {
  const root = resolve(dir);
  const ready = existsSync(join(root, "index.html"));
  // 建置目錄執行期間不會變，啟動時記下哪些檔案有壓縮版本，請求時不用逐一查檔
  const compressed = new Set(
    ready ? readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => ENCODINGS.some((e) => f.endsWith(e.ext))).map((f) => join(root, f)) : [],
  );

  /** 挑瀏覽器接受的壓縮版本；有壓縮版本的檔案一律帶 Vary，快取才不會把壓縮過的內容給不支援的瀏覽器 */
  function serve(req: Request, file: string, headers: Record<string, string>): Response {
    const original = Bun.file(file);
    const variants = ENCODINGS.filter((e) => compressed.has(file + e.ext));
    if (!variants.length) return new Response(original, { headers });
    const accepted = acceptedEncodings(req.headers.get("accept-encoding"));
    const pick = variants.find((e) => accepted.has(e.name));
    const vary = { ...headers, vary: "Accept-Encoding" };
    if (!pick) return new Response(original, { headers: vary });
    return new Response(Bun.file(file + pick.ext), {
      headers: { ...vary, "content-type": headers["content-type"] ?? original.type, "content-encoding": pick.name },
    });
  }

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
        return serve(req, file, { "cache-control": hashed ? IMMUTABLE : "no-cache" });
      }
    }
    if (pathname.startsWith("/assets/")) return errorResponse(404, "找不到資源");
    return serve(req, join(root, "index.html"), { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  }

  return { ready, handle };
}
