import { fileURLToPath } from "node:url";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const web = fileURLToPath(new URL("./web", import.meta.url));

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
  ],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy,
  },
  preview: { port: Number(process.env.WEB_PORT ?? 4173), strictPort: true, proxy },
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
  },
});
