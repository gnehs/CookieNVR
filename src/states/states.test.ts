import { describe, expect, test } from "bun:test";
import { HttpError } from "../http/errors.ts";
import { samplePoints } from "./collect.ts";
import { parseFrigateConfig, parseSensorConfig } from "./config.ts";
import { REQUIRED, step, UNKNOWN, type Consensus } from "./consensus.ts";
import { encodeClassify, KIND_BLOB, parseWorkerMsg } from "./protocol.ts";

function run(readings: [string, number][], threshold = 0.8) {
  let c: Consensus = UNKNOWN;
  const switches: { from: string | null; to: string }[] = [];
  for (const [label, score] of readings) {
    const s = step(c, { label, score }, threshold);
    if (s.kind === "switched") switches.push({ from: s.from, to: s.next.current! });
    c = s.next;
  }
  return { c, switches };
}

describe("切換規則", () => {
  test("連續 3 次同一類才切換，第一次確認也算切換（從未知）", () => {
    expect(REQUIRED).toBe(3);
    expect(run([["關", 0.9], ["關", 0.9]]).c).toEqual({ current: null, candidate: { label: "關", count: 2 } });
    expect(run([["關", 0.9], ["關", 0.9], ["關", 0.9]]).switches).toEqual([{ from: null, to: "關" }]);
  });

  test("低於門檻的讀數忽略，不中斷計數", () => {
    const r = run([["關", 0.9], ["開", 0.5], ["關", 0.85], ["移動中", 0.79], ["關", 0.95]]);
    expect(r.switches).toEqual([{ from: null, to: "關" }]);
  });

  test("換了類別從 1 重新數；讀到目前狀態就清掉候選", () => {
    const base: [string, number][] = [["關", 0.9], ["關", 0.9], ["關", 0.9]];
    expect(run([...base, ["開", 0.9], ["開", 0.9], ["移動中", 0.9]]).c).toEqual({ current: "關", candidate: { label: "移動中", count: 1 } });
    expect(run([...base, ["開", 0.9], ["開", 0.9], ["關", 0.9], ["開", 0.9]]).c).toEqual({ current: "關", candidate: { label: "開", count: 1 } });
    expect(run([...base, ["開", 0.9], ["開", 0.9], ["開", 0.9]]).switches.at(-1)).toEqual({ from: "關", to: "開" });
  });
});

describe("感應器設定", () => {
  const ok = { name: " 鐵捲門 ", classes: ["關", "移動中", "開"], crop: [0.5, 0.3, 0.9, 0.95] };

  test("省略的欄位用預設值，PUT 時沿用原值", () => {
    const c = parseSensorConfig(ok);
    expect(c).toEqual({ name: "鐵捲門", classes: ["關", "移動中", "開"], crop: [0.5, 0.3, 0.9, 0.95], threshold: 0.8, intervalSec: 10, onMotion: true, enabled: true });
    expect(parseSensorConfig(ok, { ...c, threshold: 0.9, onMotion: false }).threshold).toBe(0.9);
    expect(parseSensorConfig({ ...ok, intervalSec: 0 }).intervalSec).toBe(0);
  });

  test.each([
    [{ ...ok, classes: ["關"] }, "類別要 2 到 10 個"],
    [{ ...ok, classes: ["關", "關"] }, "不可重複"],
    [{ ...ok, classes: ["關", "../x"] }, "不可含"],
    [{ ...ok, classes: ["關", ".hidden"] }, "不可含"],
    [{ ...ok, crop: [0.9, 0.3, 0.5, 0.95] }, "區域太小"],
    [{ ...ok, crop: [0, 0, 1.2, 1] }, "0 到 1"],
    [{ ...ok, threshold: 0.3 }, "信心門檻"],
    [{ ...ok, intervalSec: 2.5 }, "整數"],
    [{ ...ok, name: "" }, "名稱"],
  ])("拒絕不合法的設定 %#", (input, message) => {
    expect(() => parseSensorConfig(input)).toThrow(message);
  });

  test("錯誤帶 code 與參數", () => {
    const code = (input: unknown) => {
      try {
        parseSensorConfig(input);
      } catch (e) {
        return e instanceof HttpError ? e.msg : null;
      }
      return null;
    };
    expect(code({ ...ok, classes: ["關"] })).toEqual({ code: "states.classCount", params: { min: 2, max: 10 } });
    expect(code({ ...ok, classes: ["關", "../x"] })).toEqual({ code: "states.classNameChars", params: { renamed: false } });
    expect(code({ ...ok, intervalSec: 2.5 })).toEqual({ code: "states.intervalRange", params: { min: 0, max: 3600 } });
  });
});

describe("Frigate 設定片段", () => {
  test("讀完整的 classification 區塊；interval 沒寫是不定時，motion 預設 false", () => {
    const r = parseFrigateConfig(`
classification:
  custom:
    garage:
      threshold: 0.85
      state_config:
        motion: true
        interval: 10
        cameras:
          front:
            crop: [0.4, 0.3, 0.9, 0.95]
    gate:
      state_config:
        cameras:
          yard:
            crop: [0, 0, 0.5, 0.5]
`);
    expect(r.sensors).toEqual([
      { name: "garage", camera: "front", crop: [0.4, 0.3, 0.9, 0.95], threshold: 0.85, intervalSec: 10, onMotion: true },
      { name: "gate", camera: "yard", crop: [0, 0, 0.5, 0.5], threshold: 0.8, intervalSec: 0, onMotion: false },
    ]);
  });

  test("也接受從模型名稱開始的片段", () => {
    expect(parseFrigateConfig("garage:\n  state_config:\n    cameras:\n      c1:\n        crop: [0.1, 0.1, 0.2, 0.2]").sensors[0]?.camera).toBe("c1");
  });

  test("沒有狀態辨識設定或 YAML 壞掉時回清楚的錯誤", () => {
    expect(() => parseFrigateConfig("cameras:\n  front: {}")).toThrow("找不到狀態辨識的設定");
    expect(() => parseFrigateConfig("a: [1, 2")).toThrow("看不懂");
  });
});

describe("從錄影抽樣", () => {
  test("沿著所有已完成的片段平均取點，略過錄製中的片段", () => {
    const segs = [
      { path: "a.mp4", startMs: 0, endMs: 60_000 },
      { path: "b.mp4", startMs: 100_000, endMs: 160_000 },
      { path: "live.mp4", startMs: 200_000, endMs: null },
    ];
    const pts = samplePoints(segs, 4);
    expect(pts.map((p) => p.path)).toEqual(["a.mp4", "a.mp4", "b.mp4", "b.mp4"]);
    expect(pts.map((p) => p.offset)).toEqual([15, 45, 15, 45]);
    expect(pts[2]!.at).toBe(115_000);
    expect(samplePoints([], 10)).toEqual([]);
  });
});

describe("worker 訊息", () => {
  test("辨識結果帶著裁切後的 JPEG", () => {
    const head = new TextEncoder().encode(JSON.stringify({ type: "reading", id: 3, label: "開", score: 0.97, ms: 24 }));
    const body = new Uint8Array(4 + head.length + 3);
    new DataView(body.buffer).setUint32(0, head.length);
    body.set(head, 4);
    body.set([0xff, 0xd8, 0xff], 4 + head.length);
    const msg = parseWorkerMsg(KIND_BLOB, body);
    expect(msg?.type === "reading" && msg.reading).toEqual({ kind: "ok", id: 3, label: "開", score: 0.97, ms: 24, crop: new Uint8Array([0xff, 0xd8, 0xff]) });
  });

  test("請求的框架：種類 3、JSON 長度、JSON、JPEG", () => {
    const bytes = encodeClassify({ type: "classify", id: 1, sensor: "s", model: "/m.json", crop: [0, 0, 1, 1], mode: "force" }, new Uint8Array([1, 2]));
    const view = new DataView(bytes.buffer);
    expect(bytes[0]).toBe(KIND_BLOB);
    expect(view.getUint32(1)).toBe(bytes.length - 5);
    const n = view.getUint32(5);
    expect(JSON.parse(new TextDecoder().decode(bytes.slice(9, 9 + n))).mode).toBe("force");
    expect([...bytes.slice(9 + n)]).toEqual([1, 2]);
  });

  test("worker 回報的 code：認得的照用，不認得的當原文", () => {
    const enc = new TextEncoder();
    const result = (extra: object) => parseWorkerMsg(1, enc.encode(JSON.stringify({ type: "job-result", job: 1, ok: false, error: "中文", ...extra })));
    expect(result({ code: "states.classesWithoutImages", params: { classes: ["關"] } })).toMatchObject({ errorMsg: { code: "states.classesWithoutImages", params: { classes: ["關"] } } });
    expect(result({ code: "nope" })).toMatchObject({ errorMsg: { code: "raw", params: { text: "中文" } } });
    expect(result({})).toMatchObject({ errorMsg: { code: "raw", params: { text: "中文" } } });
  });
});
