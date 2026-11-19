import { describe, expect, test } from "bun:test";
import type { ObjectsStatusDto } from "../../src/api-types.ts";
import { LIMITS } from "../../src/detect/config.ts";
import { labelsProblem, objectsView, posToScore, scoreToPos, speedText, strictnessOf } from "./object-model.ts";

const status = (o: Partial<ObjectsStatusDto> = {}): ObjectsStatusDto => ({
  state: "ready",
  requested: "auto",
  device: "cpu",
  fallback: null,
  error: null,
  model: { id: "builtin", name: "內建", format: "yolo", input: [640, 640] },
  latencyMs: null,
  processed: 0,
  dropped: 0,
  ...o,
});

describe("嚴格程度", () => {
  test("滑桿兩端是允許的範圍，來回換算不變", () => {
    expect(posToScore(0)).toBe(LIMITS.objectScore.min);
    expect(posToScore(100)).toBe(LIMITS.objectScore.max);
    for (const s of [0.3, 0.5, 0.65, 0.95]) expect(posToScore(scoreToPos(s))).toBe(s);
  });

  test("預設的 0.5 是標準，往兩邊分成寬鬆與嚴格", () => {
    expect(strictnessOf(0.5)).toBe("normal");
    expect(strictnessOf(0.35)).toBe("loose");
    expect(strictnessOf(0.7)).toBe("strict");
    expect(strictnessOf(0.9)).toBe("veryStrict");
  });
});

describe("類別沒勾的提醒", () => {
  test("過濾與標註才提醒，不辨識與有勾類別都不提醒", () => {
    expect(labelsProblem("off", [])).toBeNull();
    expect(labelsProblem("filter", ["person"])).toBeNull();
    expect(labelsProblem("filter", [])).toContain("不會記錄任何事件");
    expect(labelsProblem("annotate", [])).toContain("不會標上");
  });
});

describe("物件辨識狀態", () => {
  test("使用中要說出實際用的裝置", () => {
    expect(objectsView(status({ device: "intel" })).title).toBe("使用中：Intel 內顯");
    expect(objectsView(status({ device: "nvidia" })).tone).toBe("ok");
  });

  test("退回 CPU 時是警告，帶使用者看得懂的原因，不帶技術細節", () => {
    const v = objectsView(status({ device: "cpu", fallback: { reason: "找不到 Nvidia 顯卡，改用 CPU。", detail: "CUDAExecutionProvider missing" } }));
    expect(v.tone).toBe("warn");
    expect(v.title).toBe("使用中：CPU");
    expect(v.warning).toBe("找不到 Nvidia 顯卡，改用 CPU。");
    expect(JSON.stringify(v)).not.toContain("CUDA");
  });

  test("載入中、啟動中、模型錯誤", () => {
    expect(objectsView(status({ state: "loading", device: null })).title).toContain("載入");
    expect(objectsView(status({ state: "starting", device: null })).tone).toBe("busy");
    expect(objectsView(status({ state: "off", device: null })).tone).toBe("busy");
    const bad = objectsView(status({ state: "error", device: null, error: "這不是 ONNX 模型。" }));
    expect(bad.tone).toBe("bad");
    expect(bad.note).toBe("這不是 ONNX 模型。");
  });

  test("速度只有一句話，還沒有數字就不顯示", () => {
    expect(speedText(status())).toBeNull();
    expect(speedText(status({ latencyMs: { last: 10, avg: 12.4, max: 40 } }))).toBe("每張約 12 毫秒");
    expect(speedText(status({ latencyMs: { last: 0.2, avg: 0.3, max: 1 } }))).toBe("每張不到 1 毫秒");
  });
});
