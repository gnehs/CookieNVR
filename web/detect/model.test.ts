import { describe, expect, test } from "bun:test";
import { LIMITS, PREVIEW_THRESHOLDS, SENSITIVITY_PRESETS } from "../../src/detect/config.ts";
import { areaToPos, formatArea, meterY, scoreAtThreshold, posToArea, posToThreshold, sensitivityOf, thresholdToPos, TRIGGER_Y } from "./model.ts";


describe("靈敏度", () => {
  test("三個預設檔對應固定的像素門檻，其他值是自訂", () => {
    expect(sensitivityOf(SENSITIVITY_PRESETS.low)).toBe("low");
    expect(sensitivityOf(SENSITIVITY_PRESETS.medium)).toBe("medium");
    expect(sensitivityOf(SENSITIVITY_PRESETS.high)).toBe("high");
    expect(sensitivityOf(20)).toBe("custom");
  });

  test("滑桿往右更靈敏（門檻變小），兩端是允許的範圍", () => {
    expect(posToThreshold(0)).toBe(LIMITS.threshold.max);
    expect(posToThreshold(100)).toBe(LIMITS.threshold.min);
    expect(posToThreshold(thresholdToPos(25))).toBe(25);
    expect(thresholdToPos(15)).toBeGreaterThan(thresholdToPos(35));
  });
});

describe("最小面積", () => {
  test("滑桿兩端是允許的範圍，來回換算不變", () => {
    expect(posToArea(0)).toBe(LIMITS.minArea.min);
    expect(posToArea(100)).toBe(LIMITS.minArea.max);
    expect(posToArea(areaToPos(0.005))).toBe(0.005);
  });

  test("用百分比顯示", () => {
    expect(formatArea(0.005)).toBe("0.5%");
    expect(formatArea(0.0012)).toBe("0.12%");
    expect(formatArea(0.25)).toBe("25%");
  });
});

describe("量表", () => {
  test("分數剛好等於最小面積時落在觸發線上，越大越高但不超過頂端", () => {
    expect(meterY(0.005, 0.005)).toBeCloseTo(TRIGGER_Y);
    expect(meterY(0, 0.005)).toBe(0);
    expect(meterY(0.002, 0.005)).toBeLessThan(TRIGGER_Y);
    expect(meterY(1, 0.005)).toBeLessThan(1);
    expect(meterY(0.05, 0.005)).toBeGreaterThan(meterY(0.01, 0.005));
  });
});

describe("scoreAtThreshold", () => {
  const curve = PREVIEW_THRESHOLDS.map((t) => 1 / t);
  test("門檻在表上就直接用那一點，三個預設檔都在表上", () => {
    for (const t of Object.values(SENSITIVITY_PRESETS)) expect(scoreAtThreshold(curve, t)).toBe(1 / t);
  });
  test("兩點之間線性內插，超出範圍取兩端", () => {
    expect(scoreAtThreshold(curve, 27.5)).toBeCloseTo((1 / 25 + 1 / 30) / 2);
    expect(scoreAtThreshold(curve, 0)).toBe(1);
    expect(scoreAtThreshold(curve, 999)).toBe(1 / 255);
  });
  test("滑桿能選到的範圍都在表內", () => {
    expect(PREVIEW_THRESHOLDS[0]).toBe(LIMITS.threshold.min);
    expect(PREVIEW_THRESHOLDS[PREVIEW_THRESHOLDS.length - 1]).toBe(LIMITS.threshold.max);
  });
});
