import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cgroupMemoryUsed,
  drmUtilization,
  normalizePciId,
  parseCpuList,
  parseCpuMax,
  parseCpuStatUsage,
  parseDrmFdinfo,
  parseIoregAccelerator,
  parseKeyValues,
  parseMeminfo,
  parseMemoryMax,
  parseNvidiaSmi,
  parsePidStat,
  parsePsCpu,
  parsePsTime,
  parseSelfCgroup,
  parseVmStat,
} from "./parse.ts";

const fixture = (name: string) => Bun.file(join(import.meta.dir, "fixtures", name)).text();

describe("cgroup v2", () => {
  test("cpu.max quota in cores, none for max", () => {
    expect(parseCpuMax("150000 100000\n")).toBe(1.5);
    expect(parseCpuMax("max 100000\n")).toBeNull();
    expect(parseCpuMax("")).toBeNull();
  });
  test("cpu.stat usage", () => {
    expect(parseCpuStatUsage("usage_usec 11400\nuser_usec 3420\nsystem_usec 7980\n")).toBe(11400);
    expect(parseCpuStatUsage("nr_periods 1\n")).toBeNull();
  });
  test("cpuset lists", () => {
    expect(parseCpuList("0-3\n")).toBe(4);
    expect(parseCpuList("0-3,6,8-9")).toBe(7);
    expect(parseCpuList("\n")).toBeNull();
    expect(parseCpuList("garbage")).toBeNull();
  });
  test("memory.max", () => {
    expect(parseMemoryMax("536870912\n")).toBe(536870912);
    expect(parseMemoryMax("max\n")).toBeNull();
  });
  test("memory.stat from a real container: used = current − inactive_file", async () => {
    const stat = parseKeyValues(await fixture("linux-memory.stat"));
    expect(stat.has("anon")).toBe(true);
    expect(stat.has("inactive_file")).toBe(true);
    const inactive = stat.get("inactive_file")!;
    expect(cgroupMemoryUsed(inactive + 1000, stat)).toBe(1000);
    expect(cgroupMemoryUsed(0, stat)).toBe(0);
  });
  test("/proc/self/cgroup", () => {
    expect(parseSelfCgroup("0::/\n")).toBe("/");
    expect(parseSelfCgroup("0::/docker/abc123\n")).toBe("/docker/abc123");
    expect(parseSelfCgroup("12:cpu,cpuacct:/docker/x\n")).toBeNull();
  });
});

describe("/proc", () => {
  test("meminfo from a real container", async () => {
    const m = parseMeminfo(await fixture("linux-meminfo.txt"))!;
    expect(m.totalBytes).toBeGreaterThan(m.availableBytes);
    expect(m.availableBytes).toBeGreaterThan(0);
    expect(parseMeminfo("MemTotal: 1 kB\n")).toBeNull();
  });
  test("pid stat from a real container", async () => {
    const p = parsePidStat(await fixture("linux-pid-stat.txt"), 4096)!;
    expect(p.pid).toBe(1);
    expect(p.ppid).toBe(0);
    expect(p.rssBytes).toBe(320 * 4096);
  });
  test("pid stat with spaces and parens in the command name", () => {
    const line = "42 (my (odd) proc) S 7 42 42 0 -1 0 0 0 0 0 250 50 0 0 20 0 1 0 100 1000 99 0";
    expect(parsePidStat(line, 4096)).toEqual({ pid: 42, ppid: 7, cpuSec: 3, rssBytes: 99 * 4096 });
    expect(parsePidStat("nonsense", 4096)).toBeNull();
  });
});

describe("macOS", () => {
  test("ps cumulative time formats", () => {
    expect(parsePsTime("0:01.50")).toBe(1.5);
    expect(parsePsTime("1565:18.26")).toBeCloseTo(1565 * 60 + 18.26);
    expect(parsePsTime("01:02:03")).toBe(3723);
    expect(parsePsTime("2-01:00:00")).toBe(2 * 86400 + 3600);
    expect(parsePsTime("bad")).toBeNull();
  });
  test("ps from the dev machine", async () => {
    const list = parsePsCpu(await fixture("macos-ps.txt"));
    expect(list.length).toBeGreaterThan(30);
    expect(list.every((p) => p.cpuSec >= 0 && p.rssBytes >= 0)).toBe(true);
  });
  test("vm_stat from the dev machine", async () => {
    const v = parseVmStat(await fixture("macos-vm_stat.txt"))!;
    expect(v.usedBytes).toBeGreaterThan(1024 ** 3);
    expect(v.usedBytes).toBeLessThan(64 * 1024 ** 3);
    expect(parseVmStat("nothing")).toBeNull();
  });
  test("ioreg from the dev machine", async () => {
    const list = parseIoregAccelerator(await fixture("macos-ioreg.txt"));
    expect(list).toHaveLength(1);
    expect(list[0]!.model).toBe("Apple M5 Pro");
    expect(list[0]!.utilPct).toBeGreaterThanOrEqual(0);
  });
});

describe("nvidia-smi", () => {
  test("two GPUs, one with unsupported fields", async () => {
    const [a, b] = parseNvidiaSmi(await fixture("nvidia-smi.csv"));
    expect(a).toEqual({ index: 0, pciBusId: "0000:01:00.0", name: "NVIDIA GeForce RTX 3060", utilPct: 37, memUsedBytes: 1834 * 1048576, memTotalBytes: 12288 * 1048576, temperatureC: 54 });
    expect(b!.utilPct).toBeNull();
    expect(b!.temperatureC).toBeNull();
    expect(b!.memTotalBytes).toBe(15360 * 1048576);
  });
  test("a name with a comma, noise lines", () => {
    const [g, ...rest] = parseNvidiaSmi("0, 00000000:65:00.0, Quadro RTX 4000, Mobile, 5, 10, 8192, 41\nNo devices were found\n");
    expect(g!.name).toBe("Quadro RTX 4000, Mobile");
    expect(g!.temperatureC).toBe(41);
    expect(rest).toHaveLength(0);
  });
  test("PCI ids match the sysfs spelling", () => {
    expect(normalizePciId("00000000:01:00.0")).toBe("0000:01:00.0");
    expect(normalizePciId("0000:3B:00.0")).toBe("0000:3b:00.0");
  });
});

describe("DRM fdinfo", () => {
  test("i915: busiest engine over the interval, video capacity 2", async () => {
    const a = parseDrmFdinfo(await fixture("i915-fdinfo-a.txt"))!;
    const b = parseDrmFdinfo(await fixture("i915-fdinfo-b.txt"))!;
    expect(a.driver).toBe("i915");
    expect(a.pdev).toBe("0000:00:02.0");
    expect(a.capacity.get("video")).toBe(2);
    // render +0.5 s = 10 %, video +4 s over 2 engines = 40 %, video-enhance 5 %
    expect(drmUtilization([a], [b], 5e9)).toBeCloseTo(40);
  });
  test("xe: cycles over total cycles", async () => {
    const a = parseDrmFdinfo(await fixture("xe-fdinfo-a.txt"))!;
    const b = parseDrmFdinfo(await fixture("xe-fdinfo-b.txt"))!;
    expect(a.driver).toBe("xe");
    // rcs +50 M of +100 M cycles = 50 %, vcs +60 M over 2 engines = 30 %
    expect(drmUtilization([a], [b], 5e9)).toBeCloseTo(50);
  });
  test("no baseline yet, or a client that just appeared", async () => {
    const b = parseDrmFdinfo(await fixture("i915-fdinfo-b.txt"))!;
    expect(drmUtilization(null, [b], 5e9)).toBeNull();
    expect(drmUtilization([], [b], 5e9)).toBe(0);
  });
  test("not a DRM fd", () => {
    expect(parseDrmFdinfo("pos: 0\nflags: 02\n")).toBeNull();
  });
});
