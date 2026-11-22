import { expect, test } from "bun:test";
import { MAX_JSON_BYTES, readJson } from "./validate.ts";

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("http://nvr.local/api/auth/login", { method: "POST", body, headers });

test("a JSON body is parsed", async () => {
  expect(await readJson(post(JSON.stringify({ username: "root" })))).toEqual({ username: "root" });
});

test("a body that is not JSON is a 400", async () => {
  await expect(readJson(post("{"))).rejects.toMatchObject({ status: 400 });
  await expect(readJson(post(""))).rejects.toMatchObject({ status: 400 });
});

test("a body over the limit is refused, with or without a Content-Length", async () => {
  const big = JSON.stringify({ pad: "x".repeat(MAX_JSON_BYTES) });
  await expect(readJson(post(big))).rejects.toMatchObject({ status: 413 });
  const chunked = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < 4; i++) c.enqueue(new TextEncoder().encode("x".repeat(MAX_JSON_BYTES / 2)));
      c.close();
    },
  });
  await expect(readJson(post(chunked))).rejects.toMatchObject({ status: 413 });
});
