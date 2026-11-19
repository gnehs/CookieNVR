import { expect, test } from "bun:test";
import { attribute, byCategory } from "./breakdown.ts";
import type { ProcSample } from "./parse.ts";
import { decideScope } from "./system.ts";

const MB = 1024 * 1024;
const p = (pid: number, ppid: number, cpuSec: number, mb: number): ProcSample => ({ pid, ppid, cpuSec, rssBytes: mb * MB });

// main bun (100) → mediamtx (200); record bun wrapper (300) → ffmpeg (301); live (400); a stray ffprobe (500); someone else's process (900)
const before = new Map([
  [100, 10],
  [200, 20],
  [300, 1],
  [301, 50],
  [400, 5],
  [900, 99],
]);
const now = [p(100, 1, 11, 120), p(200, 100, 22, 60), p(300, 100, 1, 30), p(301, 300, 54, 80), p(400, 100, 5.5, 40), p(500, 100, 0.5, 10), p(900, 1, 200, 999)];
const targets = [
  { id: "restream", kind: "restream" as const, pid: 200 },
  { id: "record:cam1", kind: "record" as const, pid: 300 },
  { id: "live:cam1:sub", kind: "live" as const, pid: 400 },
  { id: "record:cam2", kind: "record" as const, pid: 999 },
];

test("CPU and memory are charged to the worker tree that owns each process", () => {
  // 10 s on 2 cores: 1 CPU-second = 5 %
  const b = attribute(now, before, 10, 2, targets, 100);
  const w = Object.fromEntries(b.workers.map((x) => [x.id, x]));
  expect(w["restream"]!.cpuPct).toBeCloseTo(10);
  expect(w["record:cam1"]!.cpuPct).toBeCloseTo(20);
  expect(w["record:cam1"]!.memBytes).toBe(110 * MB);
  expect(w["record:cam1"]!.processes).toBe(2);
  expect(w["live:cam1:sub"]!.cpuPct).toBeCloseTo(2.5);
  // a worker whose pid is gone reads zero instead of disappearing
  expect(w["record:cam2"]!.cpuPct).toBe(0);
  // main process +1 s, plus the new ffprobe with all of its 0.5 s
  expect(b.system.cpuPct).toBeCloseTo(7.5);
  expect(b.system.memBytes).toBe(130 * MB);
});

test("categories in a fixed order, with per-camera parts where a worker belongs to one camera", () => {
  const u = byCategory(attribute(now, before, 10, 2, targets, 100));
  expect(u.map((x) => x.category)).toEqual(["record", "detect", "detector", "live", "restream", "homekit", "export", "system"]);
  const rec = u.find((x) => x.category === "record")!;
  expect(rec.cpuPct).toBeCloseTo(20);
  expect(rec.cameras).toEqual([
    { cameraId: "cam1" as never, cpuPct: expect.closeTo(20) as never, memBytes: 110 * MB },
    { cameraId: "cam2" as never, cpuPct: 0, memBytes: 0 },
  ]);
  expect(u.find((x) => x.category === "restream")!.cameras).toEqual([]);
  const total = u.reduce((a, x) => a + x.cpuPct, 0);
  expect(total).toBeCloseTo(40);
});

test("scope: limited containers report their own limit, unlimited ones the host", () => {
  const host = { hostCores: 8, hostMemBytes: 16 * 1024 * MB };
  expect(decideScope({ ...host, quotaCores: null, cpusetCores: null, memLimitBytes: null })).toEqual({
    cpu: { scope: "host", cores: 8, quotaCores: null, cpusetCores: null },
    memory: { scope: "host", totalBytes: 16 * 1024 * MB, limitBytes: null },
  });
  const limited = decideScope({ ...host, quotaCores: 1.5, cpusetCores: 8, memLimitBytes: 512 * MB });
  expect(limited.cpu).toMatchObject({ scope: "container", cores: 1.5 });
  expect(limited.memory).toMatchObject({ scope: "container", totalBytes: 512 * MB });
  // cpuset narrower than the quota wins; a memory "limit" above host RAM is no limit
  expect(decideScope({ ...host, quotaCores: 6, cpusetCores: 2, memLimitBytes: 64 * 1024 * MB }).cpu.cores).toBe(2);
  expect(decideScope({ ...host, quotaCores: null, cpusetCores: null, memLimitBytes: 64 * 1024 * MB }).memory.scope).toBe("host");
});
