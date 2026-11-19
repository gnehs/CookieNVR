// 在實機（或實機的容器）上檢查系統資源量測讀到什麼。把整段輸出貼回來即可。
//   docker exec cookienvr mkdir -p /app/scripts
//   docker cp scripts/metrics-probe.ts cookienvr:/app/scripts/metrics-probe.ts
//   docker exec cookienvr bun scripts/metrics-probe.ts
// 不在容器裡：bun scripts/metrics-probe.ts
import { type MetricsIo, systemIo } from "../src/metrics/io.ts";
import { metricsReport } from "../src/metrics/report.ts";
import { createMetrics } from "../src/metrics/sampler.ts";
import { listProcSamples } from "../src/metrics/system.ts";

const io: MetricsIo = systemIo;
const section = (title: string) => console.log(`\n===== ${title} =====`);
const raw = async (path: string) => console.log(`--- ${path}\n${(await io.readText(path))?.trimEnd() ?? "（讀不到）"}`);

section("cgroup 與 /proc 原始檔案");
for (const p of ["/proc/self/cgroup", "/sys/fs/cgroup/cpu.max", "/sys/fs/cgroup/cpuset.cpus.effective", "/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/cpu.stat"]) await raw(p);
const meminfo = (await io.readText("/proc/meminfo"))?.split("\n").filter((l) => /^(MemTotal|MemAvailable):/.test(l)).join("\n");
console.log(`--- /proc/meminfo（節錄）\n${meminfo ?? "（讀不到）"}`);

section("nvidia-smi 原始輸出");
const nv = await io.run(["nvidia-smi", "--query-gpu=index,pci.bus_id,name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"], 5_000);
console.log(nv.missing ? "找不到 nvidia-smi" : `結束碼 ${nv.code}${nv.timedOut ? "（逾時）" : ""}\n${nv.stdout.trimEnd()}\n${nv.stderr.trimEnd()}`);
console.log(`/dev/nvidiactl ${(await io.exists("/dev/nvidiactl")) ? "存在" : "不存在"}；NVIDIA_VISIBLE_DEVICES=${process.env.NVIDIA_VISIBLE_DEVICES ?? "（未設定）"}；NVIDIA_DRIVER_CAPABILITIES=${process.env.NVIDIA_DRIVER_CAPABILITIES ?? "（未設定）"}`);

section("DRM 顯示卡（/sys/class/drm）與 /dev/dri");
for (const card of ((await io.readDir("/sys/class/drm")) ?? []).filter((n) => /^card\d+$/.test(n)).sort()) {
  const dev = `/sys/class/drm/${card}/device`;
  const vendor = (await io.readText(`${dev}/vendor`))?.trim();
  const device = (await io.readText(`${dev}/device`))?.trim();
  const driver = await io.realPath(`${dev}/driver`);
  const nodes = (await io.readDir(`${dev}/drm`)) ?? [];
  console.log(`${card}：vendor ${vendor} device ${device}，PCI ${await io.realPath(dev)}，驅動 ${driver}，節點 ${nodes.join(" ")}`);
}
console.log(`/dev/dri：${((await io.readDir("/dev/dri")) ?? ["（不存在）"]).join(" ")}`);
let shown = 0;
for (const pid of ((await io.readDir("/proc")) ?? []).filter((n) => /^\d+$/.test(n))) {
  for (const fd of (await io.readDir(`/proc/${pid}/fd`)) ?? []) {
    const target = await io.readLink(`/proc/${pid}/fd/${fd}`);
    if (!target?.startsWith("/dev/dri/") || shown >= 3) continue;
    shown++;
    const cmd = (await io.readText(`/proc/${pid}/comm`))?.trim();
    console.log(`--- /proc/${pid}/fdinfo/${fd}（${cmd}，${target}）\n${(await io.readText(`/proc/${pid}/fdinfo/${fd}`))?.trimEnd()}`);
  }
}
if (shown === 0) console.log("目前沒有程序開著 /dev/dri（沒有用到 GPU 的 ffmpeg 時是正常的）");

section("量測模組讀到的結果（取樣兩次，間隔 3 秒）");
const metrics = createMetrics({ targets: () => [], io });
await metrics.read({ watch: true });
await Bun.sleep(3_000);
await metrics.sample();
const d = await metrics.diagnostics();
console.log(metricsReport(d).join("\n"));
const procs = await listProcSamples(io, d.source?.pageSize ?? 4096);
console.log(`看得到 ${procs.length} 個程序，RSS 合計 ${(procs.reduce((a, p) => a + p.rssBytes, 0) / 1024 ** 2).toFixed(0)} MB`);
console.log(JSON.stringify({ cpu: d.latest?.cpu, memory: d.latest?.memory, gpus: d.latest?.gpus, gpuMissing: d.latest?.gpuMissing }, null, 2));
