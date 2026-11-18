import { expect, test } from "bun:test";
import { sourceUrls } from "./source-urls.ts";

test("Tapo 由 IP 與帳密推導 stream1 與 stream2", () => {
  expect(sourceUrls({ type: "tapo", host: "192.168.1.20", username: "cam", password: "secret" })).toEqual({
    main: "rtsp://cam:secret@192.168.1.20:554/stream1",
    sub: "rtsp://cam:secret@192.168.1.20:554/stream2",
  });
});

test("Tapo 帳密中的特殊字元會被編碼，還原後與原值相同", () => {
  const { main } = sourceUrls({ type: "tapo", host: "10.0.0.5", username: "a b@c", password: "p@ss:w/rd#?%" });
  const url = new URL(main);
  expect(url.hostname).toBe("10.0.0.5");
  expect(url.port).toBe("554");
  expect(url.pathname).toBe("/stream1");
  expect(decodeURIComponent(url.username)).toBe("a b@c");
  expect(decodeURIComponent(url.password)).toBe("p@ss:w/rd#?%");
});

test("Tapo 的 IPv6 位址會加上中括號", () => {
  expect(sourceUrls({ type: "tapo", host: "fe80::1", username: "u", password: "p" }).main).toBe(
    "rtsp://u:p@[fe80::1]:554/stream1",
  );
});

test("通用 RTSP 直接使用填入的網址，沒填子碼流就是 null", () => {
  expect(sourceUrls({ type: "rtsp", mainUrl: "rtsp://h/a", subUrl: "rtsp://h/b", transport: "tcp" })).toEqual({
    main: "rtsp://h/a",
    sub: "rtsp://h/b",
  });
  expect(sourceUrls({ type: "rtsp", mainUrl: "rtsp://h/a", transport: "udp" }).sub).toBeNull();
  expect(sourceUrls({ type: "rtsp", mainUrl: "rtsp://h/a", subUrl: "", transport: "udp" }).sub).toBeNull();
});

import { splitHostPort } from "./source-urls.ts";

test("Tapo 主機欄可以帶自訂埠，不會被當成 IPv6", () => {
  const tapo = (host: string) => sourceUrls({ type: "tapo", host, username: "u", password: "p" }).main;
  expect(tapo("127.0.0.1:28555")).toBe("rtsp://u:p@127.0.0.1:28555/stream1");
  expect(tapo("cam.local:8554")).toBe("rtsp://u:p@cam.local:8554/stream1");
  expect(tapo(" 192.168.1.20 ")).toBe("rtsp://u:p@192.168.1.20:554/stream1");
  expect(tapo("fe80::1")).toBe("rtsp://u:p@[fe80::1]:554/stream1");
  expect(tapo("[fe80::1]:8554")).toBe("rtsp://u:p@[fe80::1]:8554/stream1");
  expect(splitHostPort("[fe80::1]")).toEqual({ host: "[fe80::1]", port: 554 });
});
