// 假後端的系統資源：會隨時間變動的假數字。
// 切換：啟動時 MOCK_GPU=two|one|none|unreadable、MOCK_LOAD=normal|high，
// 或執行中開 /api/mock/metrics?gpu=none&load=high（只改有帶的參數）
import type { GpuDto, MetricsDto, MetricsPointDto, UsageDto } from "../src/api-types.ts";
import type { CameraId } from "../src/types.ts";

export type MockGpu = "two" | "one" | "none" | "unreadable";
export type MockLoad = "normal" | "high";

const GB = 1024 ** 3;
const STEP = 5_000;
const HISTORY = 10 * 60_000;

export const mockMetricsMode: { gpu: MockGpu; load: MockLoad } = {
  gpu: (["two", "one", "none", "unreadable"] as const).find((v) => v === process.env.MOCK_GPU) ?? "two",
  load: process.env.MOCK_LOAD === "high" ? "high" : "normal",
};

/** 平滑的起伏加一點雜訊；同一個時間點永遠得到同一個值，歷史才不會每次重抓都變 */
function wave(t: number, seed: number, base: number, amp: number, periodS: number): number {
  const s = Math.sin(t / 1000 / periodS + seed) * 0.7 + Math.sin(t / 1000 / (periodS / 3.1) + seed * 2) * 0.3;
  const noise = (Math.sin(t * 0.000913 + seed * 7.7) * 43758.5453) % 1;
  return Math.min(100, Math.max(0, base + amp * s + noise * amp * 0.25));
}

const cpuAt = (t: number) => (mockMetricsMode.load === "high" ? wave(t, 1, 95, 3, 50) : wave(t, 1, 26, 10, 70));
const memAt = (t: number) => (mockMetricsMode.load === "high" ? wave(t, 2, 94, 1.5, 200) : wave(t, 2, 47, 2, 300));
const nvAt = (t: number) => wave(t, 3, 34, 18, 45);
const intelAt = (t: number) => wave(t, 4, 14, 8, 35);

function gpusAt(t: number): Omit<GpuDto, "extras">[] {
  const intel: Omit<GpuDto, "extras"> = { id: "intel:0000:00:02.0", vendor: "intel", name: "Intel 內顯", utilPct: intelAt(t), memory: null, temperatureC: null, note: null, noteMsg: null };
  const nvidia: Omit<GpuDto, "extras"> = {
    id: "nvidia:0000:01:00.0",
    vendor: "nvidia",
    name: "NVIDIA GeForce RTX 3060",
    utilPct: nvAt(t),
    memory: { usedBytes: Math.round((1.6 + nvAt(t) / 60) * GB), totalBytes: 12 * GB },
    temperatureC: Math.round(48 + nvAt(t) / 6),
    note: null,
    noteMsg: null,
  };
  return mockMetricsMode.gpu === "two" ? [intel, nvidia] : mockMetricsMode.gpu === "one" ? [intel] : [];
}

/** 依時間與攝影機清單產生一份假的 MetricsDto */
export function mockMetrics(cameraIds: CameraId[], now = Date.now(), extras: Record<string, GpuDto["extras"]> = {}): MetricsDto {
  const at = Math.floor(now / STEP) * STEP;
  const history: MetricsPointDto[] = [];
  for (let t = at - HISTORY; t <= at; t += STEP) {
    history.push({ at: t, cpuPct: cpuAt(t), memPct: memAt(t), gpus: Object.fromEntries(gpusAt(t).map((g) => [g.id, g.utilPct])) });
  }
  const cores = 8;
  const totalMem = 16 * GB;
  const cpu = cpuAt(at);
  const used = (memAt(at) / 100) * totalMem;
  // 各類別的份量：錄影每台最多，偵測其次，即時觀看只有第一台
  const share = (c: number, w: number) => (c * w) / 100;
  const perCam = (w: number, mem: number, only?: number) =>
    cameraIds.filter((_, i) => only === undefined || i === only).map((id, i) => ({ cameraId: id, cpuPct: share(cpu, w * (1 + i * 0.15)), memBytes: mem * (1 + i * 0.1) }));
  const sum = (list: { cpuPct: number; memBytes: number }[]) => list.reduce((a, x) => ({ cpuPct: a.cpuPct + x.cpuPct, memBytes: a.memBytes + x.memBytes }), { cpuPct: 0, memBytes: 0 });
  const record = perCam(4.5, 70 * 1024 ** 2);
  const detect = perCam(3, 95 * 1024 ** 2);
  const live = perCam(6, 45 * 1024 ** 2, 0);
  const usage: UsageDto[] = [
    { category: "record", ...sum(record), cameras: record },
    { category: "detect", ...sum(detect), cameras: detect },
    { category: "detector", cpuPct: 0, memBytes: 0, cameras: [] },
    { category: "live", ...sum(live), cameras: live },
    { category: "restream", cpuPct: share(cpu, 5), memBytes: 85 * 1024 ** 2, cameras: [] },
    { category: "homekit", cpuPct: 0, memBytes: 0, cameras: [] },
    { category: "export", cpuPct: 0, memBytes: 0, cameras: [] },
    { category: "system", cpuPct: share(cpu, 3), memBytes: 140 * 1024 ** 2, cameras: [] },
  ];
  const ours = sum(usage);
  const gpus = gpusAt(at).map((g) => ({ ...g, extras: extras[g.id] ?? [] }));
  return {
    at,
    intervalMs: STEP,
    cpu: { pct: cpu, cores, scope: "host" },
    memory: { usedBytes: used, totalBytes: totalMem, scope: "host" },
    gpus,
    gpuMissing: gpus.length ? null : mockMetricsMode.gpu === "unreadable" ? "unreadable" : "none",
    usage,
    other: { cpuPct: Math.max(0, cpu - ours.cpuPct), memBytes: Math.max(0, used - ours.memBytes) },
    history,
  };
}

/** GET /api/mock/metrics?gpu=&load=：示範時切換情境，回傳目前的設定 */
export function setMockMetrics(q: URLSearchParams): typeof mockMetricsMode {
  const gpu = q.get("gpu");
  if (gpu === "two" || gpu === "one" || gpu === "none" || gpu === "unreadable") mockMetricsMode.gpu = gpu;
  const load = q.get("load");
  if (load === "normal" || load === "high") mockMetricsMode.load = load;
  return mockMetricsMode;
}
