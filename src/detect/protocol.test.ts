import { expect, test } from "bun:test";
import { parseCameraConfig } from "../http/parse.ts";
import { detectConfigOf, DEFAULT_DETECT } from "./config.ts";
import { encodeMsg, JpegSplitter, MsgKind, MsgReader } from "./protocol.ts";

test("messages survive arbitrary chunking", () => {
  const a = encodeMsg(MsgKind.frame, new TextEncoder().encode('{"x":1}'));
  const b = encodeMsg(MsgKind.jpeg, new Uint8Array([1, 2, 3]));
  const all = new Uint8Array([...a, ...b]);
  const reader = new MsgReader();
  const got = [];
  for (let i = 0; i < all.length; i += 3) got.push(...reader.push(all.subarray(i, i + 3)));
  expect(got.map((m) => [m.kind, [...m.payload]])).toEqual([
    [MsgKind.frame, [...new TextEncoder().encode('{"x":1}')]],
    [MsgKind.jpeg, [1, 2, 3]],
  ]);
});

test("JPEGs are cut at SOI and EOI across chunks", () => {
  const j1 = [0xff, 0xd8, 5, 0xff, 0x00, 6, 0xff, 0xd9];
  const j2 = [0xff, 0xd8, 7, 0xff, 0xd9];
  const s = new JpegSplitter();
  const bytes = new Uint8Array([...j1, ...j2]);
  const out = [...s.push(bytes.subarray(0, 4)), ...s.push(bytes.subarray(4, 9)), ...s.push(bytes.subarray(9))];
  expect(out.map((x) => [...x])).toEqual([j1, j2]);
});

const base = {
  name: "前門",
  enabled: true,
  connection: { type: "tapo", host: "192.0.2.1", username: "u", password: "p" },
  record: { enabled: true, audio: false, direct: false },
};

test("old camera data without detect gets the defaults", () => {
  expect(detectConfigOf(parseCameraConfig(base))).toEqual(DEFAULT_DETECT);
});

test("detect settings are validated", () => {
  const detect = { enabled: true, source: "both", threshold: 15, minArea: 0.01, cooldownSec: 30, masks: [{ points: [[0, 0], [1, 0], [0.5, 0.5]] }] };
  expect(parseCameraConfig({ ...base, detect }).detect).toEqual(detect as never);
  for (const bad of [{ source: "x" }, { threshold: 0 }, { minArea: 0.9 }, { masks: [{ points: [[0, 0], [1, 1]] }] }, { masks: [{ points: [[0, 0], [2, 0], [0, 1]] }] }]) {
    expect(() => parseCameraConfig({ ...base, detect: { ...detect, ...bad } })).toThrow();
  }
});
