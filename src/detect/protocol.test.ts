import { expect, test } from "bun:test";
import { parseCameraConfig, parseSettingsPatch } from "../http/parse.ts";
import { defaultSettings } from "../types.ts";
import { detectConfigOf, DEFAULT_DETECT } from "./config.ts";
import { encodeMsg, MsgReader } from "../workers/framing.ts";
import { JpegSplitter, MsgKind } from "./protocol.ts";

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
  // 沒送物件辨識欄位的舊用戶端拿到預設值
  expect(parseCameraConfig({ ...base, detect }).detect).toEqual({ ...detect, maxEventSec: 600, objectMasks: [], labels: ["person"], objectMode: "annotate", objectScore: 0.5 } as never);
  const zone = { points: [[0, 0.5], [0.4, 0.5], [0.4, 1]] };
  expect(parseCameraConfig({ ...base, detect: { ...detect, objectMasks: [zone] } }).detect?.objectMasks).toEqual([zone] as never);
  const objects = { ...detect, labels: ["dog", "person", "dog"], objectMode: "filter", objectScore: 0.7 };
  expect(parseCameraConfig({ ...base, detect: objects }).detect).toMatchObject({ labels: ["dog", "person"], objectMode: "filter", objectScore: 0.7 });
  expect(parseCameraConfig({ ...base, detect: { ...detect, maxEventSec: 120 } }).detect?.maxEventSec).toBe(120);
  for (const bad of [{ source: "x" }, { threshold: 0 }, { minArea: 0.9 }, { masks: [{ points: [[0, 0], [1, 1]] }] }, { masks: [{ points: [[0, 0], [2, 0], [0, 1]] }] }, { labels: ["Chair"] }, { labels: ["a b"] }, { labels: "person" }, { objectMode: "on" }, { objectScore: 0.1 }, { objectMasks: "x" }, { maxEventSec: 59 }, { maxEventSec: 3601 }, { maxEventSec: 90.5 }, { objectMasks: [{ points: [[0, 0], [1, 1]] }] }]) {
    expect(() => parseCameraConfig({ ...base, detect: { ...detect, ...bad } })).toThrow();
  }
});

test("object settings merge with the current ones and reject paths in model names", () => {
  const current = defaultSettings("/data");
  expect(parseSettingsPatch({ objects: { enabled: true } }, current).objects).toEqual({ enabled: true, model: "builtin", fps: 2 });
  expect(parseSettingsPatch({ objects: { fps: 0.5, model: "yolov8n.onnx" } }, current).objects).toMatchObject({ fps: 0.5, model: "yolov8n.onnx" });
  for (const bad of [{ fps: 4 }, { model: "../x.onnx" }, { model: "a/b.onnx" }, { model: "x.pt" }, { extra: 1 }]) {
    expect(() => parseSettingsPatch({ objects: bad }, current)).toThrow();
  }
  for (const ok of ["auto", "cpu", "intel:GPU.1", "nvidia:GPU-8c6d1a2e-0b4f-4c55-9d1a-2b3c4d5e6f70"]) {
    expect(parseSettingsPatch({ devices: { objects: ok } }, current).devices).toEqual({ objects: ok, decode: "auto" });
    expect(parseSettingsPatch({ devices: { decode: ok } }, current).devices).toEqual({ objects: "auto", decode: ok });
  }
  for (const bad of ["gpu", "nvidia:../x", "intel", ""]) {
    expect(() => parseSettingsPatch({ devices: { objects: bad } }, current)).toThrow();
    expect(() => parseSettingsPatch({ devices: { decode: bad } }, current)).toThrow();
  }
  expect(() => parseSettingsPatch({ devices: { encode: "cpu" } }, current)).toThrow();
});
