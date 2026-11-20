import { describe, expect, test } from "bun:test";
import type { StateModelDto, StateSensorDto } from "../../src/api-types.ts";
import { classesError, classIndexOfKey, moveRect, needsText, planClassEdit, rectFrom, resizeRect, resultSummary, rowsOf, sensorView, sinceText, stateText, trainStatus } from "./model.ts";

function sensor(o: Partial<StateSensorDto> = {}): StateSensorDto {
  return {
    id: "s1",
    cameraId: "c1" as StateSensorDto["cameraId"],
    config: { name: "鐵捲門", classes: ["關", "開"], crop: [0, 0, 1, 1], threshold: 0.8, intervalSec: 10, onMotion: true, enabled: true },
    state: null,
    since: null,
    score: null,
    candidate: null,
    lastReading: null,
    model: null,
    images: { pending: 0, labeled: [{ label: "關", count: 0 }, { label: "開", count: 0 }] },
    trainable: false,
    job: null,
    problem: null,
    createdAt: 0,
    ...o,
  };
}

const model = (o: Partial<StateModelDto> = {}): StateModelDto => ({
  trainedAt: 0,
  classes: ["關", "移動中", "開"],
  counts: [{ label: "關", count: 29 }, { label: "移動中", count: 26 }, { label: "開", count: 86 }],
  validation: {
    folds: 5,
    accuracy: 0.97,
    perClass: [{ label: "關", correct: 29, total: 29 }, { label: "移動中", correct: 22, total: 26 }, { label: "開", correct: 86, total: 86 }],
    confusion: [[29, 0, 0], [0, 22, 4], [0, 0, 86]],
  },
  trainMs: 1000,
  backbone: "x",
  ...o,
});

describe("類別驗證", () => {
  test("重複、空白、路徑字元與數量", () => {
    expect(classesError(["關", "開"])).toBeNull();
    expect(classesError(["關", " 關 "])).toEqual({ index: 1, message: "“關” is used twice" });
    expect(classesError(["關", ""])?.index).toBe(1);
    expect(classesError(["a/b", "開"])?.index).toBe(0);
    expect(classesError([".hidden", "開"])?.index).toBe(0);
    expect(classesError(["關"])).toEqual({ index: null, message: "Add at least 2 classes" });
    expect(classesError(Array.from({ length: 11 }, (_, i) => `c${i}`))?.message).toBe("At most 10 classes");
  });
});

describe("目前狀態", () => {
  const now = new Date(2026, 10, 20, 15, 0).getTime();
  test("已知狀態顯示從何時開始", () => {
    const v = sensorView(sensor({ state: "開", since: now - 12 * 60_000 }));
    expect(stateText(v, now)).toBe("開 · 12 minutes ago");
  });
  test("候選和目前狀態一樣時不算確認中", () => {
    expect(sensorView(sensor({ state: "開", since: now, candidate: { label: "開", count: 1 } }))).toMatchObject({ kind: "state", candidate: null });
    expect(sensorView(sensor({ state: "開", since: now, candidate: { label: "關", count: 2 } }))).toMatchObject({ kind: "state", candidate: "關" });
  });
  test("還不知道狀態時是確認中", () => {
    expect(stateText(sensorView(sensor({ candidate: { label: "關", count: 1 } })), now)).toBe("Confirming: 關");
    expect(stateText(sensorView(sensor()), now)).toBe("Confirming…");
  });
  test("問題優先於狀態，暫停不算問題", () => {
    expect(sensorView(sensor({ problem: { code: "untrained", message: "m" } }))).toMatchObject({ kind: "problem", code: "untrained" });
    expect(sensorView(sensor({ problem: { code: "disabled", message: "m" } }))).toMatchObject({ kind: "paused" });
    expect(sensorView(sensor({ problem: { code: "paused", message: "鏡頭移動中" } }))).toEqual({ kind: "paused", message: "鏡頭移動中" });
  });
  test("時間的說法", () => {
    expect(sinceText(now - 30_000, now)).toBe("Just now");
    expect(sinceText(now - 3 * 3_600_000, now)).toBe("3 hours ago");
    expect(sinceText(new Date(2026, 10, 20, 7, 5).getTime(), now)).toBe("Today 07:05");
    expect(sinceText(new Date(2026, 10, 19, 14, 5).getTime(), now)).toBe("Yesterday 14:05");
    expect(sinceText(new Date(2026, 10, 17, 9, 30).getTime(), now)).toBe("11/17 09:30");
  });
});

describe("訓練", () => {
  test("還差幾張", () => {
    expect(needsText(sensor({ images: { pending: 3, labeled: [{ label: "關", count: 5 }, { label: "開", count: 1 }] } }))).toBe("Label 1 more as “開” before training");
    expect(needsText(sensor({ images: { pending: 0, labeled: [{ label: "關", count: 2 }, { label: "開", count: 2 }] } }))).toBeNull();
  });
  test("標記和訓練時不同就提示重新訓練", () => {
    const m = model({ classes: ["關", "開"], counts: [{ label: "關", count: 3 }, { label: "開", count: 3 }] });
    expect(trainStatus(sensor())).toBe("untrained");
    expect(trainStatus(sensor({ model: m, images: { pending: 0, labeled: [{ label: "關", count: 3 }, { label: "開", count: 3 }] } }))).toBe("current");
    expect(trainStatus(sensor({ model: m, images: { pending: 0, labeled: [{ label: "關", count: 4 }, { label: "開", count: 3 }] } }))).toBe("outdated");
    expect(trainStatus(sensor({ model: m, problem: { code: "stale-model", message: "" } }))).toBe("stale");
  });
  test("結果用白話：總共答對幾張、各類答對率、看錯的組合", () => {
    const r = resultSummary(model());
    expect(r.headline).toBe("Checked against your 141 labeled images: 137 correct");
    expect(r.perClass.map((p) => p.pct)).toEqual([100, 85, 100]);
    expect(r.mistakes).toEqual([{ actual: "移動中", predicted: "開", count: 4 }]);
  });
});

describe("類別編輯的計畫", () => {
  test("改名、刪除、新增", () => {
    const rows = rowsOf(["關", "移動中", "開"]);
    rows[0]!.name = "關閉";
    const edited = [rows[0]!, rows[2]!, { key: "n", original: null, name: "半開" }];
    expect(planClassEdit(["關", "移動中", "開"], edited)).toEqual({ removed: ["移動中"], renames: [{ from: "關", to: "關閉" }], classes: ["關閉", "開", "半開"] });
  });
  test("互換名稱時先借暫時的名字", () => {
    const rows = rowsOf(["關", "開"]);
    rows[0]!.name = "開";
    rows[1]!.name = "關";
    const plan = planClassEdit(["關", "開"], rows);
    expect(plan.classes).toEqual(["開", "關"]);
    // 依序套用後，原本的「關」變成「開」、原本的「開」變成「關」
    const names = new Map([["關", "關"], ["開", "開"]]);
    for (const r of plan.renames) {
      const k = [...names].find(([, v]) => v === r.from)![0];
      expect([...names.values()]).not.toContain(r.to);
      names.set(k, r.to);
    }
    expect(Object.fromEntries(names)).toEqual({ 關: "開", 開: "關" });
  });
  test("改成被刪掉的類別的名字不需要暫時名", () => {
    const rows = rowsOf(["關", "開"]);
    rows[1]!.name = "關";
    expect(planClassEdit(["關", "開"], [rows[1]!, { key: "n", original: null, name: "移動" }])).toEqual({ removed: ["關"], renames: [{ from: "開", to: "關" }], classes: ["關", "移動"] });
  });
});

describe("框選區域", () => {
  test("兩個角換成矩形，太小會撐到最小值", () => {
    expect(rectFrom([0.8, 0.9], [0.2, 0.1])).toEqual([0.2, 0.1, 0.8, 0.9]);
    const r = rectFrom([0.5, 0.5], [0.5, 0.5]);
    expect(r[2] - r[0]).toBeCloseTo(0.03);
    expect(rectFrom([1, 1], [1, 1])[0]).toBeCloseTo(0.97);
  });
  test("移動不會出畫面，縮放不會翻面", () => {
    expect(moveRect([0.1, 0.1, 0.5, 0.5], 0.8, -1)).toEqual([0.6, 0, 1, 0.4]);
    const r = resizeRect([0.2, 0.2, 0.6, 0.6], "nw", 0.9, 0.9);
    expect(r[0]).toBeCloseTo(0.57);
    expect(r[1]).toBeCloseTo(0.57);
    expect(resizeRect([0.2, 0.2, 0.6, 0.6], "e", 0.8, 0)).toEqual([0.2, 0.2, 0.8, 0.6]);
  });
});

test("數字鍵對應類別", () => {
  expect(classIndexOfKey("1", 3)).toBe(0);
  expect(classIndexOfKey("3", 3)).toBe(2);
  expect(classIndexOfKey("4", 3)).toBeNull();
  expect(classIndexOfKey("0", 10)).toBe(9);
  expect(classIndexOfKey("a", 3)).toBeNull();
});
