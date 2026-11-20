import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { webApp } from "./web-app.ts";

const dir = mkdtempSync(join(tmpdir(), "cookienvr-web-"));
mkdirSync(join(dir, "assets"));
writeFileSync(join(dir, "index.html"), "<div id=app></div>");
writeFileSync(join(dir, "assets", "main-abc123.js"), "console.log(1)");
writeFileSync(join(dir, "robots.txt"), "no");
const bundle = "console.log('bundle');".repeat(100);
writeFileSync(join(dir, "assets", "big-def456.js"), bundle);
writeFileSync(join(dir, "assets", "big-def456.js.br"), brotliCompressSync(bundle));
writeFileSync(join(dir, "assets", "big-def456.js.gz"), gzipSync(bundle));
writeFileSync(join(dir, "index.html.gz"), gzipSync("<div id=app></div>"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = webApp(dir);
const get = (path: string, method = "GET", headers: Record<string, string> = {}) =>
  app.handle(new Request(`http://nvr.local${path}`, { method, headers }));

test("deep links get index.html, uncached, so a reload stays on the page", async () => {
  for (const path of ["/", "/cameras", "/settings/cameras/front-door", "/link/ABCD-EFGH"]) {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain('id=app');
  }
});

test("hashed assets are cached for good; other files are revalidated", async () => {
  const asset = await get("/assets/main-abc123.js");
  expect(asset.status).toBe(200);
  expect(asset.headers.get("cache-control")).toContain("immutable");
  expect((await get("/robots.txt")).headers.get("cache-control")).toBe("no-cache");
});

test("a missing asset is a 404, not the page", async () => {
  expect((await get("/assets/main-old.js")).status).toBe(404);
});

test("API paths never fall through to the page", async () => {
  const res = await get("/api/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "找不到資源", code: "http.notFound" });
});

test("paths cannot escape the build directory", async () => {
  const res = await get("/..%2f..%2fetc%2fpasswd");
  expect(await res.text()).toContain("id=app");
  expect((await get("/cameras", "POST")).status).toBe(405);
});

test("without a build the page explains how to make one", async () => {
  const missing = webApp(join(dir, "nope"));
  expect(missing.ready).toBe(false);
  const res = await missing.handle(new Request("http://nvr.local/cameras"));
  expect(res.status).toBe(503);
  expect(await res.text()).toContain("bun run build");
});

test("precompressed builds go out in the best encoding the browser accepts", async () => {
  const br = await get("/assets/big-def456.js", "GET", { "accept-encoding": "gzip, deflate, br, zstd" });
  expect(br.headers.get("content-encoding")).toBe("br");
  expect(br.headers.get("content-type")).toContain("javascript");
  expect(br.headers.get("vary")).toBe("Accept-Encoding");
  expect(br.headers.get("cache-control")).toContain("immutable");
  expect(brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString()).toBe(bundle);

  const gz = await get("/assets/big-def456.js", "GET", { "accept-encoding": "gzip, br;q=0" });
  expect(gz.headers.get("content-encoding")).toBe("gzip");
  expect(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()).toBe(bundle);

  const plain = await get("/assets/big-def456.js");
  expect(plain.headers.get("content-encoding")).toBeNull();
  expect(plain.headers.get("vary")).toBe("Accept-Encoding");
  expect(await plain.text()).toBe(bundle);
});

test("deep links get the compressed page too, still as HTML", async () => {
  const res = await get("/settings/storage", "GET", { "accept-encoding": "br, gzip" });
  expect(res.headers.get("content-encoding")).toBe("gzip");
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()).toContain("id=app");
});

test("files without a compressed copy are sent as is, without Vary", async () => {
  const res = await get("/assets/main-abc123.js", "GET", { "accept-encoding": "br, gzip" });
  expect(res.headers.get("content-encoding")).toBeNull();
  expect(res.headers.get("vary")).toBeNull();
});
