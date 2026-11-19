import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const web = fileURLToPath(new URL("./web", import.meta.url));
const outDir = fileURLToPath(new URL("./dist/web", import.meta.url));

/** 建置完替文字檔產生 .br 與 .gz，主程序依 Accept-Encoding 直接給，不在請求時壓縮（`src/http/web-app.ts`） */
function precompress(): Plugin {
  return {
    name: "cookienvr-precompress",
    apply: "build",
    closeBundle() {
      for (const entry of readdirSync(outDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !/\.(js|css|html|svg|json|txt)$/.test(entry.name)) continue;
        const file = join(entry.parentPath, entry.name);
        const raw = readFileSync(file);
        if (raw.length < 1024) continue;
        const br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
        const gz = gzipSync(raw, { level: 9 });
        if (br.length < raw.length) writeFileSync(`${file}.br`, br);
        if (gz.length < raw.length) writeFileSync(`${file}.gz`, gz);
      }
    },
  };
}

// 開發時 /api 交給後端：真的主程序（bun run dev，預設 8765）或假後端（bun run dev:mock 會設好 API_URL）
const api = process.env.API_URL ?? "http://127.0.0.1:8765";
// 只比對 /api/…：寫成 "/api" 會把 web/api.ts 這種原始檔的請求也代理出去
const proxy = { "^/api/": { target: api } };

export default defineConfig({
  root: web,
  publicDir: false,
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: `${web}/routes`,
      generatedRouteTree: `${web}/routeTree.gen.ts`,
    }),
    react(),
    precompress(),
  ],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy,
  },
  preview: { port: Number(process.env.WEB_PORT ?? 4173), strictPort: true, proxy },
  build: {
    outDir,
    emptyOutDir: true,
  },
});
