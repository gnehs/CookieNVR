import { expect, test } from "bun:test";
import { metricsReport } from "./report.ts";
import type { MetricsDiagnostics } from "./sampler.ts";

const GB = 1024 ** 3;

test("the report names the scope, every GPU source with its failure reason, and the sampler's own cost", () => {
  const d: MetricsDiagnostics = {
    platform: "linux x64",
    source: {
      cgroup: { version: 2, dir: "/sys/fs/cgroup" },
      hostCores: 8,
      hostMemBytes: 16 * GB,
      cpu: { scope: "container", cores: 2, quotaCores: 2, cpusetCores: null },
      memory: { scope: "container", totalBytes: 2 * GB, limitBytes: 2 * GB },
      pageSize: 4096,
    },
    memoryDetail: "memory.current 1 − inactive_file 0",
    latest: {
      at: 0,
      intervalMs: 5000,
      cpu: { pct: 42, cores: 2, scope: "container" },
      memory: { usedBytes: GB, totalBytes: 2 * GB, scope: "container" },
      gpus: [{ id: "intel:0000:00:02.0", vendor: "intel", name: "Intel 內顯", utilPct: 12, memory: null, temperatureC: null, note: null, extras: [{ label: "物件辨識", value: "每秒 8 張" }] }],
      gpuMissing: null,
      usage: [{ category: "record", cpuPct: 10, memBytes: 100 * 1024 ** 2, cameras: [] }],
      other: { cpuPct: 32, memBytes: GB },
      history: [],
    },
    workers: [{ id: "record:a", kind: "record", cpuPct: 10, memBytes: 100 * 1024 ** 2, processes: 1 }],
    probes: [
      { source: "nvidia-smi", state: "error", detail: "nvidia-smi 結束碼 9：NVIDIA 驅動程式沒有載入", gpus: [] },
      { source: "intel-drm", state: "ok", detail: "1 張", gpus: [] },
    ],
    gpuDetails: [{ id: "intel:0000:00:02.0", detail: "card0（/dev/dri/renderD128）" }],
    cost: { cheapMs: 0.4, fullMs: 6.2, samples: 10 },
    watched: true,
  };
  const text = metricsReport(d).join("\n");
  expect(text).toContain("CPU 範圍：容器（cgroup 上限），可用 2 核心");
  expect(text).toContain("nvidia-smi：失敗，nvidia-smi 結束碼 9：NVIDIA 驅動程式沒有載入");
  expect(text).toContain("GPU Intel 內顯（intel:0000:00:02.0）：使用率 12.0%");
  expect(text).toContain("物件辨識：每秒 8 張");
  expect(text).toContain("record:a：CPU 10.0%");
  expect(text).toContain("加上各程序與 GPU 時平均 6.2 ms");
});
