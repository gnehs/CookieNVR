import { describe, expect, test } from "bun:test";
import type { BenchmarkDto, BenchmarkResultDto, InferenceDeviceDto } from "../../src/api-types.ts";
import { benchmarkView, endedText, headlineOf, progressOf, verdictOf } from "./benchmark-model.ts";

const res = (o: Partial<BenchmarkResultDto>): BenchmarkResultDto => ({ device: "cpu", kind: "cpu", name: "Intel(R) Core(TM) i5", ok: true, fps: 14, msMean: 71.2, msP90: 96.5, loadMs: 900, cameras: 3, ...o });
const bench = (o: Partial<BenchmarkDto> = {}): BenchmarkDto => ({
  state: "done",
  startedAt: 1_000,
  finishedAt: 36_000,
  model: "builtin",
  perCameraFps: 2,
  progress: null,
  results: [res({})],
  error: null,
  stale: false,
  verdict: { device: "cpu", supported: 3, cameras: 2, state: "enough" },
  ...o,
});
const fmt = (ms: number) => `t${ms}`;
const opts = { currentDevice: "cpu", models: [], formatTime: fmt };

describe("測速結論", () => {
  test("一句話：幾台、每台每秒幾次", () => {
    expect(headlineOf(bench(), "cpu")).toEqual({ tone: "ok", text: "這台機器大約可以同時處理 3 台攝影機（每台每秒辨識 2 次）" });
    expect(headlineOf(bench({ perCameraFps: 0.5 }), "cpu")?.text).toContain("每台每 2 秒辨識 1 次");
  });

  test("以目前使用的裝置為準；沒測到它就用最快的", () => {
    const b = bench({ results: [res({ cameras: 3 }), res({ device: "nvidia:x", kind: "nvidia", name: "GTX", cameras: 38, fps: 96 })] });
    expect(headlineOf(b, "cpu")?.text).toContain("3 台");
    expect(headlineOf(b, "intel:GPU.0")?.text).toContain("38 台");
  });

  test("撐不住 1 台時直說，並建議降低頻率或換裝置", () => {
    const h = headlineOf(bench({ results: [res({ cameras: 0 })] }), "cpu");
    expect(h?.tone).toBe("bad");
    expect(h?.text).toContain("降低辨識頻率");
  });

  test("沒有成功的結果就沒有結論", () => {
    expect(headlineOf(bench({ results: [res({ ok: false, error: "找不到這個裝置", fps: undefined, cameras: undefined })] }), "cpu")).toBeNull();
  });
});

describe("對照目前設定", () => {
  test("夠用、不夠用、沒開辨識的攝影機各一句話", () => {
    expect(verdictOf(bench())?.text).toContain("來得及");
    const partial = verdictOf(bench({ verdict: { device: "cpu", supported: 1, cameras: 4, state: "partial" } }));
    expect(partial?.tone).toBe("warn");
    expect(partial?.text).toContain("最多處理 1 台");
    expect(verdictOf(bench({ verdict: { device: "cpu", supported: 3, cameras: 0, state: "enough" } }))?.text).toContain("沒有攝影機");
  });

  test("過期的結果不下結論；沒測到使用中的裝置時請使用者重測", () => {
    expect(verdictOf(bench({ stale: true }))).toBeNull();
    expect(verdictOf(bench({ verdict: null }))?.text).toContain("測一次目前使用的裝置");
  });
});

describe("多個裝置並排", () => {
  const b = bench({
    results: [res({}), res({ device: "intel:GPU.0", kind: "intel", name: "Intel(R) UHD Graphics 630", fps: 31, cameras: 12 }), res({ device: "nvidia:x", kind: "nvidia", name: "NVIDIA GTX", fps: 96, cameras: 38 }), res({ device: "nvidia:y", kind: "nvidia", name: "bad", ok: false, error: "找不到這個裝置", fps: undefined, cameras: undefined })],
  });
  const v = benchmarkView(b, opts);

  test("每個裝置一行：型號與約幾台，標出使用中與最快", () => {
    expect(v.rows.map((r) => [r.name, r.text])).toEqual([["Intel Core i5", "約 3 台"], ["Intel UHD Graphics 630", "約 12 台"], ["NVIDIA GTX", "約 38 台"], ["bad", "無法測速"]]);
    expect(v.rows.map((r) => r.current)).toEqual([true, false, false, false]);
    expect(v.rows.map((r) => r.best)).toEqual([false, false, true, false]);
    expect(v.rows[3]!.detail).toBe("找不到這個裝置");
  });

  test("細節是白話的一句，不出現縮寫", () => {
    expect(v.rows[0]!.detail).toBe("每秒約 14.0 張，平均每張 71 毫秒，最慢的一成約 97 毫秒，載入花了 0.9 秒");
    expect(v.rows[0]!.detail).not.toMatch(/p90|fps/i);
  });

  test("只測一個裝置時沒有最快標記，時間與裝置、模型放在同一行", () => {
    const one = benchmarkView(bench(), opts);
    expect(one.rows[0]!.best).toBe(false);
    expect(one.meta).toBe("上次測速：t36000・Intel Core i5・內建模型");
  });

  test("過期標示跟著 stale", () => {
    expect(benchmarkView(bench({ stale: true }), opts).stale).toBe(true);
  });
});

describe("測速進度", () => {
  const devices: InferenceDeviceDto[] = [{ id: "cpu", kind: "cpu", name: "Intel(R) Core(TM) i5" }, { id: "nvidia:x", kind: "nvidia", name: "NVIDIA GTX" }];
  test("第幾個裝置、整體進度", () => {
    const p = progressOf(bench({ state: "running", progress: { device: "nvidia:x", index: 1, total: 2, fraction: 0.5 } }), devices);
    expect(p.text).toBe("第 2 個裝置，共 2 個：NVIDIA GTX");
    expect(p.fraction).toBe(0.75);
  });
  test("只有一個裝置不說第幾個；還沒開始是準備中", () => {
    expect(progressOf(bench({ progress: { device: "cpu", index: 0, total: 1, fraction: 0.2 } }), devices).text).toBe("測量中：Intel Core i5");
    expect(progressOf(bench({ progress: null }), devices)).toEqual({ text: "準備中…", fraction: 0 });
  });
});

test("取消與失敗的說明", () => {
  expect(endedText(bench({ state: "cancelled" }))?.text).toBe("測速已取消。");
  expect(endedText(bench({ state: "failed", error: "辨識程序中斷了。" }))?.text).toBe("辨識程序中斷了。");
  expect(endedText(bench())).toBeNull();
});
