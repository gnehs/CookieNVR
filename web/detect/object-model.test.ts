import { describe, expect, test } from "bun:test";
import type { ObjectsStatusDto } from "../../src/api-types.ts";
import { LIMITS } from "../../src/detect/config.ts";
import { deviceHint, deviceOptions, eventLabelOptions, labelGroups, labelsProblem, objectsView, objectSummary, posToScore, rateClause, scoreToPos, speedText, strictnessOf, unavailableNotes } from "./object-model.ts";

const CPU = { id: "cpu", kind: "cpu", name: "Intel(R) Core(TM) i5-9400 CPU @ 2.90GHz", pci: null } as const;
const UHD = { id: "intel:GPU.0", kind: "intel", name: "Intel(R) UHD Graphics 630", pci: null } as const;
const GTX = { id: "nvidia:GPU-aaa", kind: "nvidia", name: "NVIDIA GeForce GTX 1650", pci: null } as const;

const status = (o: Partial<ObjectsStatusDto> = {}): ObjectsStatusDto => ({
  state: "ready",
  requested: "auto",
  device: CPU,
  fallback: null,
  cpuShare: null,
  error: null,
  model: { id: "builtin", name: "內建", format: "yolo", input: [640, 640] },
  latencyMs: null,
  processed: 0,
  dropped: 0,
  rateFps: 0,
  dropRatio: null,
  paused: null,
  warning: null,
  gpu: null,
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
  test("使用中要說出實際用的裝置型號", () => {
    expect(objectsView(status({ device: UHD })).title).toBe("使用中：Intel UHD Graphics 630");
    expect(objectsView(status({ device: GTX })).tone).toBe("ok");
  });

  test("退回別的裝置時是警告，帶使用者看得懂的原因，不帶技術細節", () => {
    const v = objectsView(status({ device: CPU, fallback: { reason: "找不到 Nvidia 顯卡，改用 CPU。", detail: "CUDAExecutionProvider missing" } }));
    expect(v.tone).toBe("warn");
    expect(v.warnings).toEqual(["找不到 Nvidia 顯卡，改用 CPU。"]);
    expect(JSON.stringify(v)).not.toContain("CUDA");
  });

  test("顯示卡只做了一小部分時，說出有多少在處理器上；大多在處理器上就是警告", () => {
    expect(objectsView(status({ device: GTX, cpuShare: 0.01 })).note).toBeNull();
    const some = objectsView(status({ device: UHD, cpuShare: 0.3, latencyMs: { last: 30, avg: 30, max: 40 } }));
    expect(some.tone).toBe("ok");
    expect(some.note).toBe("每張約 30 毫秒，約 30% 的運算在處理器上執行");
    const most = objectsView(status({ device: UHD, cpuShare: 0.62 }));
    expect(most.tone).toBe("warn");
    expect(most.warnings).toEqual(["實際上大多在處理器上執行（約 62% 的運算），顯示卡幫助不大。"]);
  });

  test("負載提醒也算警告，與退回的原因並列", () => {
    const v = objectsView(status({ warning: "最近有 23% 的畫面來不及辨識。", fallback: { reason: "改用 CPU。", detail: "" } }));
    expect(v.tone).toBe("warn");
    expect(v.warnings).toEqual(["改用 CPU。", "最近有 23% 的畫面來不及辨識。"]);
  });

  test("測速中說明辨識暫停，不重複顯示警告", () => {
    const v = objectsView(status({ paused: "benchmark", warning: "x" }));
    expect(v.title).toContain("暫停");
    expect(v.tone).toBe("busy");
    expect(v.warnings).toEqual([]);
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

describe("推論裝置選單", () => {
  test("自動在最前面，接著是每個裝置的型號，CPU 也有型號", () => {
    const o = deviceOptions([CPU, UHD, GTX], "auto");
    expect(o.map((x) => x.value)).toEqual(["auto", "cpu", "intel:GPU.0", "nvidia:GPU-aaa"]);
    expect(o.map((x) => x.label)).toEqual(["自動（建議）", "Intel Core i5-9400 CPU @ 2.90GHz", "Intel UHD Graphics 630", "NVIDIA GeForce GTX 1650"]);
  });

  test("型號沒寫 CPU 時加上「處理器」前綴", () => {
    expect(deviceOptions([{ id: "cpu", kind: "cpu", name: "Apple M2", pci: null }], "auto")[1]!.label).toBe("處理器：Apple M2");
  });

  test("設定的裝置不在清單裡，補一項說明，選單才不會騙人", () => {
    const o = deviceOptions([CPU], "nvidia:GPU-gone");
    expect(o.at(-1)).toEqual({ value: "nvidia:GPU-gone", label: "（目前找不到，暫時自動選擇）" });
    expect(deviceOptions([CPU], "cpu").some((x) => x.label.includes("找不到"))).toBe(false);
  });

  test("兩張同型號的卡用編號區分", () => {
    const twin = { id: "nvidia:GPU-bbb", kind: "nvidia", name: "NVIDIA GeForce GTX 1650", pci: null } as const;
    expect(deviceOptions([GTX, twin], "auto").map((x) => x.label).slice(1)).toEqual(["NVIDIA GeForce GTX 1650（1）", "NVIDIA GeForce GTX 1650（2）"]);
  });

  test("說明依選擇變化；自動時說出實際用的裝置", () => {
    expect(deviceHint("auto", [CPU, GTX], GTX)).toContain("NVIDIA GeForce GTX 1650");
    expect(deviceHint("nvidia:GPU-gone", [CPU], null)).toContain("偵測不到");
  });

  test("不能用的原因只在使用者指定了那一類時直接顯示，其餘收起來", () => {
    const un = { intel: "沒有 /dev/dri。", nvidia: "映像沒有 Nvidia 元件。" };
    expect(unavailableNotes(un, "auto")).toEqual({ inline: [], folded: ["沒有 /dev/dri。", "映像沒有 Nvidia 元件。"] });
    expect(unavailableNotes(un, "nvidia:GPU-x")).toEqual({ inline: ["映像沒有 Nvidia 元件。"], folded: ["沒有 /dev/dri。"] });
    expect(unavailableNotes({ intel: null, nvidia: null }, "auto")).toEqual({ inline: [], folded: [] });
  });
});

test("辨識頻率的說法", () => {
  expect(rateClause(2)).toBe("每秒辨識 2 次");
  expect(rateClause(0.5)).toBe("每 2 秒辨識 1 次");
});

describe("類別清單", () => {
  const catalog = {
    labels: [
      { key: "person", zh: "人", en: "Person" },
      { key: "car", zh: "汽車", en: "Car" },
      { key: "toaster", zh: "烤麵包機", en: "Toaster" },
      { key: "package", zh: "包裹", en: "Package" },
    ],
    common: ["person", "car", "dog"],
  };

  test("預設列常用類別（模型沒有的略過），其餘收進更多類別", () => {
    const g = labelGroups(catalog, ["person"]);
    expect(g.common.map((l) => l.key)).toEqual(["person", "car"]);
    expect(g.more.map((l) => l.key)).toEqual(["toaster", "package"]);
    expect(g.moreHasSelected).toBe(false);
    expect(g.noPackage).toBe(false);
  });

  test("更多類別裡有已勾選的就標出來；不在模型裡的已勾類別留在常用清單，才取消得掉", () => {
    expect(labelGroups(catalog, ["toaster"]).moreHasSelected).toBe(true);
    expect(labelGroups(catalog, ["person", "dog"]).common.map((l) => l.key)).toEqual(["person", "car", "dog"]);
  });

  test("沒有包裹類別時提示，自訂模型有包裹就不提示", () => {
    expect(labelGroups({ ...catalog, labels: catalog.labels.slice(0, 3) }, []).noPackage).toBe(true);
    expect(labelGroups(null, []).noPackage).toBe(false);
  });

  test("事件篩選：只列有開啟的類別與事件裡出現過的（含相機自己的 vehicle），不重複", () => {
    const o = eventLabelOptions(catalog, ["dog", "person"], ["vehicle", "person"]);
    expect(o.map((l) => l.key).sort()).toEqual(["dog", "person", "vehicle"]);
    expect(o.find((l) => l.key === "vehicle")?.zh).toBe("車輛");
  });

  test("事件篩選依出現次數由多到少排，沒出現過的有開類別照目錄順序墊底", () => {
    const o = eventLabelOptions(catalog, ["person", "car", "dog"], ["dog", "vehicle", "dog", "vehicle", "dog", "person"]);
    expect(o.map((l) => l.key)).toEqual(["dog", "vehicle", "person", "car"]);
  });

  test("沒開也沒出現過的類別不列", () => {
    expect(eventLabelOptions(catalog, [], []).length).toBe(0);
  });

  test("拿不到目錄時只剩有開的與出現過的類別", () => {
    expect(eventLabelOptions(null, ["cat"], ["person"]).map((l) => l.key)).toEqual(["person", "cat"]);
  });
});

describe("卡片摘要", () => {
  test("不辨識沒有摘要", () => {
    expect(objectSummary("off", ["person"])).toBeNull();
  });
  test("標註與過濾的說法不同，類別多時收成「等 N 類」", () => {
    expect(objectSummary("annotate", ["person", "car"])).toBe("辨識人與汽車");
    expect(objectSummary("filter", ["person"])).toBe("只記錄人");
    expect(objectSummary("filter", ["person", "car", "dog"])).toBe("只記錄人、汽車與狗");
    expect(objectSummary("annotate", ["person", "car", "dog", "cat"])).toBe("辨識人、汽車等 4 類");
  });
  test("過濾模式沒勾類別會提醒不會記錄事件", () => {
    expect(objectSummary("filter", [])).toBe("未選類別，不記錄事件");
  });
});
