import { describe, expect, test } from "bun:test";
import type { BenchmarkDto, BenchmarkResultDto, InferenceDeviceDto } from "../../src/api-types.ts";
import { msg } from "../../src/messages/index.ts";
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
  errorMsg: null,
  stale: false,
  verdict: { device: "cpu", supported: 3, cameras: 2, state: "enough" },
  ...o,
});
const fmt = (ms: number) => `t${ms}`;
const opts = { currentDevice: "cpu", models: [], formatTime: fmt };

describe("測速結論", () => {
  test("一句話：幾台、每台每秒幾次", () => {
    expect(headlineOf(bench(), "cpu")).toEqual({ tone: "ok", text: "This machine can handle about 3 cameras at the same time (each detecting 2 times per second)" });
    expect(headlineOf(bench({ perCameraFps: 0.5 }), "cpu")?.text).toContain("each detecting once every 2 seconds");
  });

  test("以目前使用的裝置為準；沒測到它就用最快的", () => {
    const b = bench({ results: [res({ cameras: 3 }), res({ device: "nvidia:x", kind: "nvidia", name: "GTX", cameras: 38, fps: 96 })] });
    expect(headlineOf(b, "cpu")?.text).toContain("about 3 cameras");
    expect(headlineOf(b, "intel:GPU.0")?.text).toContain("about 38 cameras");
  });

  test("撐不住 1 台時直說，並建議降低頻率或換裝置", () => {
    const h = headlineOf(bench({ results: [res({ cameras: 0 })] }), "cpu");
    expect(h?.tone).toBe("bad");
    expect(h?.text).toContain("lowering the detection rate");
  });

  test("沒有成功的結果就沒有結論", () => {
    expect(headlineOf(bench({ results: [res({ ok: false, error: "找不到這個裝置", fps: undefined, cameras: undefined })] }), "cpu")).toBeNull();
  });
});

describe("實際在哪裡執行", () => {
  const gpu = (o: Partial<BenchmarkResultDto>) => res({ device: "intel:GPU.0", kind: "intel", name: "Intel(R) UHD Graphics 630", fps: 15, cameras: 6, ...o });

  test("顯示卡的成績其實大多是處理器跑的，結論要說清楚", () => {
    const h = headlineOf(bench({ results: [gpu({ cpuShare: 0.7 })] }), "intel:GPU.0");
    expect(h).toEqual({ tone: "warn", text: "This machine can handle about 6 cameras at the same time (each detecting 2 times per second). Intel UHD Graphics 630: Mostly runs on the CPU in practice (about 70% of the work), so the graphics card helps little" });
    expect(headlineOf(bench({ results: [gpu({ cpuShare: 0.02 })] }), "intel:GPU.0")?.tone).toBe("ok");
  });

  test("並排時在該列標出比例", () => {
    const view = benchmarkView(bench({ results: [res({}), gpu({ cpuShare: 0.7 }), gpu({ device: "nvidia:x", kind: "nvidia", name: "GTX", cpuShare: 0.2 })] }), opts);
    expect(view.rows.map((r) => [r.tone, r.note?.tone ?? null])).toEqual([["ok", null], ["warn", "warn"], ["ok", "ok"]]);
    expect(view.rows[2]!.note?.text).toBe("20% of the work runs on the CPU");
  });

  test("顯示卡沒有實際執行模型時是失敗，用白話說原因", () => {
    const failed = gpu({ ok: false, fps: undefined, cameras: undefined, reason: "Intel UHD Graphics 630 沒有實際執行這個模型（OpenVINO 把運算交回處理器），這個裝置不適合用來辨識", error: "NotOnDevice: 實際執行 CPUExecutionProvider 100%" });
    expect(headlineOf(bench({ results: [failed] }), "cpu")).toEqual({ tone: "bad", text: `${failed.reason}.` });
    const view = benchmarkView(bench({ results: [res({}), failed] }), opts);
    expect(view.rows[1]).toMatchObject({ text: "Unavailable", tone: "bad", note: { tone: "warn", text: failed.reason } });
    expect(view.rows[1]!.detail).toContain("CPUExecutionProvider 100%");
  });
});

describe("對照目前設定", () => {
  test("夠用、不夠用、沒開辨識的攝影機各一句話", () => {
    expect(verdictOf(bench())?.text).toContain("can all keep up");
    const partial = verdictOf(bench({ verdict: { device: "cpu", supported: 1, cameras: 4, state: "partial" } }));
    expect(partial?.tone).toBe("warn");
    expect(partial?.text).toContain("only 1 can be handled");
    expect(verdictOf(bench({ verdict: { device: "cpu", supported: 3, cameras: 0, state: "enough" } }))?.text).toContain("No cameras");
  });

  test("過期的結果不下結論；沒測到使用中的裝置時請使用者重測", () => {
    expect(verdictOf(bench({ stale: true }))).toBeNull();
    expect(verdictOf(bench({ verdict: null }))?.text).toContain("Run a test on it");
  });
});

describe("多個裝置並排", () => {
  const b = bench({
    results: [res({}), res({ device: "intel:GPU.0", kind: "intel", name: "Intel(R) UHD Graphics 630", fps: 31, cameras: 12 }), res({ device: "nvidia:x", kind: "nvidia", name: "NVIDIA GTX", fps: 96, cameras: 38 }), res({ device: "nvidia:y", kind: "nvidia", name: "bad", ok: false, error: "找不到這個裝置", fps: undefined, cameras: undefined })],
  });
  const v = benchmarkView(b, opts);

  test("每個裝置一行：型號與約幾台，標出使用中與最快", () => {
    expect(v.rows.map((r) => [r.name, r.text])).toEqual([["Intel Core i5", "About 3 cameras"], ["Intel UHD Graphics 630", "About 12 cameras"], ["NVIDIA GTX", "About 38 cameras"], ["bad", "Can't be benchmarked"]]);
    expect(v.rows.map((r) => r.current)).toEqual([true, false, false, false]);
    expect(v.rows.map((r) => r.best)).toEqual([false, false, true, false]);
    expect(v.rows[3]!.detail).toBe("找不到這個裝置");
  });

  test("細節是白話的一句，不出現縮寫", () => {
    expect(v.rows[0]!.detail).toBe("14.0 frames per second, 71 ms per frame on average, 97 ms for the slowest 10%, 0.9 s to load");
    expect(v.rows[0]!.detail).not.toMatch(/p90|fps/i);
  });

  test("只測一個裝置時沒有最快標記，時間與裝置、模型放在同一行", () => {
    const one = benchmarkView(bench(), opts);
    expect(one.rows[0]!.best).toBe(false);
    expect(one.meta).toBe("Last benchmark: t36000・Intel Core i5・Built-in model");
  });

  test("過期標示跟著 stale", () => {
    expect(benchmarkView(bench({ stale: true }), opts).stale).toBe(true);
  });
});

describe("測速進度", () => {
  const devices: InferenceDeviceDto[] = [{ id: "cpu", kind: "cpu", name: "Intel(R) Core(TM) i5", pci: null }, { id: "nvidia:x", kind: "nvidia", name: "NVIDIA GTX", pci: null }];
  test("第幾個裝置、整體進度", () => {
    const p = progressOf(bench({ state: "running", progress: { device: "nvidia:x", index: 1, total: 2, fraction: 0.5 } }), devices);
    expect(p.text).toBe("Device 2 of 2: NVIDIA GTX");
    expect(p.fraction).toBe(0.75);
  });
  test("只有一個裝置不說第幾個；還沒開始是準備中", () => {
    expect(progressOf(bench({ progress: { device: "cpu", index: 0, total: 1, fraction: 0.2 } }), devices).text).toBe("Measuring: Intel Core i5");
    expect(progressOf(bench({ progress: null }), devices)).toEqual({ text: "Preparing…", fraction: 0 });
  });
});

test("取消與失敗的說明", () => {
  expect(endedText(bench({ state: "cancelled" }))?.text).toBe("Benchmark cancelled.");
  expect(endedText(bench({ state: "failed", error: "辨識程序中斷了。" }))?.text).toBe("辨識程序中斷了。");
  expect(endedText(bench())).toBeNull();
});

describe("失敗原因換成目前語言", () => {
  test("有 reasonMsg 就用它，技術訊息照原文", () => {
    const failed = res({ ok: false, reason: "中文原因", reasonMsg: msg("detector.notOnDeviceBench", { device: "UHD", runtime: "OpenVINO" }), error: "NotOnDevice: x" });
    const row = benchmarkView(bench({ results: [failed] }), opts).rows[0]!;
    expect(row.note?.text).toBe("UHD isn't actually running this model (OpenVINO handed the work back to the CPU). This device isn't suitable for detection");
    expect(row.detail).toContain("NotOnDevice: x");
  });

  test("測速失敗的原因", () => {
    expect(endedText(bench({ state: "failed", error: "推論程序重新啟動，測速中斷", errorMsg: msg("objects.benchInterrupted") }))?.text).toBe("The detector restarted, so the benchmark was interrupted");
  });
});
