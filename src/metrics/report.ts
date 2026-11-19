import type { MetricsDto } from "../api-types.ts";
import type { MetricsDiagnostics } from "./sampler.ts";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const size = (n: number) => (n >= GB ? `${(n / GB).toFixed(2)} GB` : `${(n / MB).toFixed(0)} MB`);
const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`);

const SCOPE_TEXT = { container: "容器（cgroup 上限）", host: "整台主機（容器沒有設上限，或不在容器裡）" } as const;

function historyLine(h: MetricsDto["history"]): string {
  const cpu = h.map((p) => p.cpuPct).filter((v): v is number => v !== null);
  const mem = h.map((p) => p.memPct);
  if (!cpu.length) return "- 最近 10 分鐘：還沒有足夠的取樣";
  const stats = (v: number[]) => `平均 ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)}%，最高 ${Math.max(...v).toFixed(1)}%`;
  return `- 最近 ${Math.round((h.at(-1)!.at - h[0]!.at) / 60_000)} 分鐘（${h.length} 筆）：CPU ${stats(cpu)}；記憶體 ${stats(mem)}`;
}

/** The 「系統資源」 section of the diagnostics report: every number, where it came from, and why GPUs failed. */
export function metricsReport(d: MetricsDiagnostics): string[] {
  const m = d.latest;
  const src = d.source;
  const lines = ["## 系統資源", `- 平台：${d.platform}`];
  if (src) {
    lines.push(
      `- cgroup：${src.cgroup === null ? "沒有（不在 Linux 容器裡）" : src.cgroup.version === 1 ? "v1（不讀容器上限，數字是整台主機）" : `v2，目錄 ${src.cgroup.dir}`}`,
      `- 主機：${src.hostCores} 核心，記憶體 ${size(src.hostMemBytes)}`,
      `- CPU 範圍：${SCOPE_TEXT[src.cpu.scope]}，可用 ${src.cpu.cores} 核心（cpu.max ${src.cpu.quotaCores ?? "無上限"}，cpuset ${src.cpu.cpusetCores ?? "未限制"}）`,
      `- 記憶體範圍：${SCOPE_TEXT[src.memory.scope]}，memory.max ${src.memory.limitBytes === null ? "無上限" : size(src.memory.limitBytes)}；計算方式 ${d.memoryDetail ?? "讀取失敗"}`,
    );
    if (src.cgroup !== null) lines.push(`- 記憶體分頁大小：${src.pageSize} bytes`);
  }
  if (m) {
    lines.push(
      `- 目前：CPU ${pct(m.cpu.pct)}（${m.cpu.cores} 核心為 100%），記憶體 ${size(m.memory.usedBytes)} / ${size(m.memory.totalBytes)}`,
      historyLine(m.history),
    );
    if (m.usage) {
      lines.push("- 各類工作（CPU 以全部可用核心為 100%；記憶體是常駐記憶體 RSS 加總，含子程序）：");
      for (const u of m.usage) if (u.cpuPct > 0 || u.memBytes > 0) lines.push(`    - ${u.category}：CPU ${pct(u.cpuPct)}，記憶體 ${size(u.memBytes)}`);
      if (m.other) lines.push(`    - 其他（不屬於 CookieNVR 的程式、核心與檔案快取）：CPU ${pct(m.other.cpuPct)}，記憶體 ${size(m.other.memBytes)}`);
    }
  }
  if (d.workers.length) {
    lines.push("- 各程序：");
    for (const w of d.workers) lines.push(`    - ${w.id}：CPU ${pct(w.cpuPct)}，記憶體 ${size(w.memBytes)}，${w.processes} 個程序`);
  }
  lines.push("- GPU 讀取方式：");
  for (const p of d.probes) lines.push(`    - ${p.source}：${p.state === "ok" ? "成功" : p.state === "absent" ? "不適用" : "失敗"}，${p.detail}`);
  if (!d.probes.length) lines.push("    - 還沒有讀取過");
  for (const g of m?.gpus ?? []) {
    const detail = d.gpuDetails.find((x) => x.id === g.id)?.detail;
    lines.push(
      `- GPU ${g.name}（${g.id}）：使用率 ${pct(g.utilPct)}，顯示記憶體 ${g.memory ? `${size(g.memory.usedBytes)} / ${size(g.memory.totalBytes)}` : "無"}，溫度 ${g.temperatureC === null ? "無" : `${g.temperatureC}°C`}${detail ? `；${detail}` : ""}`,
      ...g.extras.map((e) => `    - ${e.label}：${e.value}`),
    );
  }
  const c = d.cost;
  lines.push(
    `- 量測本身：每 ${(m?.intervalMs ?? 5000) / 1000} 秒一次，只讀 CPU 與記憶體時平均 ${c.cheapMs?.toFixed(1) ?? "—"} ms，加上各程序與 GPU 時平均 ${c.fullMs?.toFixed(1) ?? "—"} ms；狀態頁${d.watched ? "開著" : "沒開"}`,
    "",
  );
  return lines;
}
