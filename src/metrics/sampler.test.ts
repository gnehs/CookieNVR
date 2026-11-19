import { expect, test } from "bun:test";
import { fakeIo, ok } from "./fake-io.ts";
import { createMetrics } from "./sampler.ts";

const GB = 1024 ** 3;

/** A container limited to 2 cores and 1 GB, running main (pid 1) → record ffmpeg (pid 7). */
function container() {
  const files: Record<string, string> = {
    "/sys/fs/cgroup/cgroup.controllers": "cpuset cpu io memory pids\n",
    "/proc/self/cgroup": "0::/\n",
    "/sys/fs/cgroup/cpu.max": "200000 100000\n",
    "/sys/fs/cgroup/cpuset.cpus.effective": "0-7\n",
    "/sys/fs/cgroup/memory.max": `${GB}\n`,
    "/sys/fs/cgroup/memory.current": "644245094\n",
    "/sys/fs/cgroup/memory.stat": "anon 400000000\ninactive_file 107374182\n",
    "/sys/fs/cgroup/cpu.stat": "usage_usec 0\n",
    "/proc/meminfo": "MemTotal: 16777216 kB\nMemAvailable: 8388608 kB\n",
    "/proc/1/stat": "1 (bun) S 0 1 1 0 -1 0 0 0 0 0 100 0 0 0 20 0 1 0 1 1 25600 0",
    "/proc/7/stat": "7 (ffmpeg) S 1 1 1 0 -1 0 0 0 0 0 100 0 0 0 20 0 1 0 1 1 51200 0",
  };
  const io = fakeIo({ platform: "linux", files, commands: { getconf: ok("4096\n") } });
  return { io, files };
}

test("an unwatched sampler keeps CPU and memory history but never runs the GPU or process reads", async () => {
  let t = 1_000_000;
  const { io, files } = container();
  const m = createMetrics({ io, targets: () => [{ id: "record:cam1", kind: "record", pid: 7 }], selfPid: 1, now: () => t });
  await m.sample();
  t += 5_000;
  // 5 s on 2 cores = 10 CPU-seconds; 5 used = 50 %
  files["/sys/fs/cgroup/cpu.stat"] = "usage_usec 5000000\n";
  await m.sample();
  const d = await m.read({ watch: false });
  expect(d.cpu).toEqual({ pct: 50, cores: 2, scope: "container" });
  expect(d.memory).toEqual({ usedBytes: 644245094 - 107374182, totalBytes: GB, scope: "container" });
  expect(d.history.map((p) => p.cpuPct)).toEqual([null, 50]);
  expect(d.history[1]!.memPct).toBeCloseTo(50, 0);
  expect(d.usage).toBeNull();
  expect(d.gpuMissing).toBeNull();
  expect(io.ran).not.toContain("nvidia-smi");
});

test("watching turns on per-process usage and GPU probes; no GPU reads as none", async () => {
  let t = 1_000_000;
  const { io, files } = container();
  const m = createMetrics({ io, targets: () => [{ id: "record:cam1", kind: "record", pid: 7 }], selfPid: 1, now: () => t });
  const first = await m.read({ watch: true });
  expect(io.ran).toContain("nvidia-smi");
  expect(first.gpus).toEqual([]);
  expect(first.gpuMissing).toBe("none");
  expect(first.usage).toBeNull();
  t += 5_000;
  files["/sys/fs/cgroup/cpu.stat"] = "usage_usec 4000000\n";
  // ffmpeg used 3 s and main 0.5 s of the 10 available CPU-seconds
  files["/proc/7/stat"] = "7 (ffmpeg) S 1 1 1 0 -1 0 0 0 0 0 400 0 0 0 20 0 1 0 1 1 51200 0";
  files["/proc/1/stat"] = "1 (bun) S 0 1 1 0 -1 0 0 0 0 0 150 0 0 0 20 0 1 0 1 1 25600 0";
  await m.sample();
  const d = await m.read({ watch: true });
  const rec = d.usage!.find((u) => u.category === "record")!;
  expect(rec.cpuPct).toBeCloseTo(30);
  expect(rec.memBytes).toBe(51200 * 4096);
  expect(rec.cameras[0]!.cameraId).toBe("cam1" as never);
  expect(d.usage!.find((u) => u.category === "system")!.cpuPct).toBeCloseTo(5);
  // 40 % overall − 35 % ours
  expect(d.other!.cpuPct).toBeCloseTo(5);
  // watching expires; usage is withheld again
  t += 60_000;
  expect((await m.read({ watch: false })).usage).toBeNull();
});

test("history keeps the last 10 minutes", async () => {
  let t = 0;
  const { io } = container();
  const m = createMetrics({ io, targets: () => [], now: () => t });
  for (let i = 0; i < 150; i++) {
    await m.sample();
    t += 5_000;
  }
  const h = (await m.read({ watch: false })).history;
  expect(h.length).toBe(121);
  expect(h.at(-1)!.at - h[0]!.at).toBe(600_000);
});
