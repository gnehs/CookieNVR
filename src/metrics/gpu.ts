import { basename } from "node:path";
import type { GpuDto } from "../api-types.ts";
import type { MetricsIo } from "./io.ts";
import { type DrmClient, drmUtilization, NVIDIA_QUERY, parseDrmFdinfo, parseIoregAccelerator, parseNvidiaSmi } from "./parse.ts";

export type GpuReading = Omit<GpuDto, "extras"> & {
  /** for diagnostics only: driver, PCI device id, render node */
  detail: string;
};

export type GpuSource = "nvidia-smi" | "intel-drm" | "apple-ioreg";

/**
 * - ok: the source works (it may still list zero GPUs, e.g. no Intel card)
 * - absent: this kind of GPU is not here, nothing to fix
 * - error: the GPU seems to be here but cannot be read; `detail` says why and what to change
 */
export type ProbeOutcome =
  | { source: GpuSource; state: "ok"; detail: string; gpus: GpuReading[] }
  | { source: GpuSource; state: "absent" | "error"; detail: string; gpus: [] };

const NVIDIA_TIMEOUT_MS = 4_000;

/** nvidia-smi exit codes, from NVIDIA's nvidia-smi documentation. */
const NVIDIA_EXIT: Record<number, string> = {
  2: "參數錯誤（這版驅動可能不支援查詢的欄位）",
  3: "這張顯示卡不支援這個操作",
  4: "權限不足",
  6: "查詢失敗",
  9: "NVIDIA 驅動程式沒有載入",
  12: "找不到 NVML 函式庫（容器沒有掛入驅動程式，請確認 NVIDIA_DRIVER_CAPABILITIES 含 utility）",
  15: "顯示卡沒有回應（GPU has fallen off the bus）",
  255: "驅動程式內部錯誤",
};

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";

export async function probeNvidia(io: MetricsIo): Promise<ProbeOutcome> {
  const source = "nvidia-smi" as const;
  const r = await io.run(["nvidia-smi", `--query-gpu=${NVIDIA_QUERY}`, "--format=csv,noheader,nounits"], NVIDIA_TIMEOUT_MS);
  if (r.missing) {
    // /dev/nvidiactl shows up when the container got the GPU but not the utility capability (no nvidia-smi)
    if (io.platform === "linux" && (await io.exists("/dev/nvidiactl"))) {
      return { source, state: "error", detail: "有 /dev/nvidiactl 但找不到 nvidia-smi：容器的 NVIDIA_DRIVER_CAPABILITIES 需要包含 utility", gpus: [] };
    }
    return { source, state: "absent", detail: "找不到 nvidia-smi（沒有 Nvidia 顯示卡，或容器沒有用 NVIDIA Container Toolkit 啟動）", gpus: [] };
  }
  if (r.timedOut) return { source, state: "error", detail: `nvidia-smi 超過 ${NVIDIA_TIMEOUT_MS / 1000} 秒沒有回應`, gpus: [] };
  if (r.code !== 0) {
    const why = r.code !== null ? NVIDIA_EXIT[r.code] : undefined;
    return { source, state: "error", detail: `nvidia-smi 結束碼 ${r.code}${why ? `：${why}` : ""}${firstLine(r.stderr || r.stdout) ? `（${firstLine(r.stderr || r.stdout)}）` : ""}`, gpus: [] };
  }
  const list = parseNvidiaSmi(r.stdout);
  if (list.length === 0) return { source, state: "error", detail: `nvidia-smi 沒有列出任何顯示卡：${firstLine(r.stdout) || "沒有輸出"}`, gpus: [] };
  return {
    source,
    state: "ok",
    detail: `${list.length} 張`,
    gpus: list.map((g) => {
      const missing = [g.utilPct === null && "使用率", g.memTotalBytes === null && "顯示記憶體", g.temperatureC === null && "溫度"].filter(Boolean);
      return {
        id: `nvidia:${g.pciBusId}`,
        vendor: "nvidia",
        name: g.name,
        utilPct: g.utilPct,
        memory: g.memUsedBytes !== null && g.memTotalBytes !== null ? { usedBytes: g.memUsedBytes, totalBytes: g.memTotalBytes } : null,
        temperatureC: g.temperatureC,
        note: missing.length ? `這張顯示卡不提供${missing.join("、")}` : null,
        detail: `nvidia-smi index ${g.index}，PCI ${g.pciBusId}`,
      };
    }),
  };
}

interface DrmCard {
  card: string;
  pdev: string;
  vendor: string;
  device: string;
  driver: string;
  renderNode: string | null;
}

async function listDrmCards(io: MetricsIo): Promise<DrmCard[]> {
  const names = (await io.readDir("/sys/class/drm")) ?? [];
  const cards: DrmCard[] = [];
  for (const card of names.filter((n) => /^card\d+$/.test(n)).sort()) {
    const dev = `/sys/class/drm/${card}/device`;
    const vendor = (await io.readText(`${dev}/vendor`))?.trim().toLowerCase();
    if (!vendor) continue;
    const real = await io.realPath(dev);
    const driver = await io.realPath(`${dev}/driver`);
    const render = ((await io.readDir(`${dev}/drm`)) ?? []).find((n) => n.startsWith("renderD")) ?? null;
    cards.push({
      card,
      pdev: real ? basename(real).toLowerCase() : card,
      vendor,
      device: (await io.readText(`${dev}/device`))?.trim().toLowerCase() ?? "?",
      driver: driver ? basename(driver) : "?",
      renderNode: render,
    });
  }
  return cards;
}

/** hwmon temperature in °C; integrated GPUs usually have none. */
async function hwmonTemp(io: MetricsIo, card: string): Promise<number | null> {
  const base = `/sys/class/drm/${card}/device/hwmon`;
  for (const h of (await io.readDir(base)) ?? []) {
    const milli = Number((await io.readText(`${base}/${h}/temp1_input`))?.trim());
    if (Number.isFinite(milli) && milli > 0) return Math.round(milli / 1000);
  }
  return null;
}

/**
 * Every DRM client visible in /proc. Only fds that link to /dev/dri/* are read, so the cost is one
 * readlink per open fd. In a container this sees the container's own processes (our ffmpeg), not
 * the host's.
 */
async function drmClients(io: MetricsIo): Promise<DrmClient[]> {
  const pids = ((await io.readDir("/proc")) ?? []).filter((n) => /^\d+$/.test(n));
  const seen = new Map<string, DrmClient>();
  for (const pid of pids) {
    const fds = await io.readDir(`/proc/${pid}/fd`);
    if (!fds) continue;
    for (const fd of fds) {
      const target = await io.readLink(`/proc/${pid}/fd/${fd}`);
      if (!target?.startsWith("/dev/dri/")) continue;
      const text = await io.readText(`/proc/${pid}/fdinfo/${fd}`);
      const c = text ? parseDrmFdinfo(text) : null;
      // dup'ed fds and child processes share a client; count each client once
      if (c) seen.set(`${c.pdev}#${c.clientId}`, c);
    }
  }
  return [...seen.values()];
}

export interface IntelProbe {
  probe(io: MetricsIo, nowNs: number): Promise<ProbeOutcome>;
}

/**
 * Intel GPUs through sysfs (to find them) and DRM fdinfo (to measure them). fdinfo needs no special
 * permission for our own processes, unlike `intel_gpu_top` which uses the i915 PMU and needs
 * perf_event_paranoid ≤ 0 or root. Keeps the previous reading to compute utilisation as a delta.
 */
export function createIntelProbe(): IntelProbe {
  let prev: { atNs: number; clients: DrmClient[] } | null = null;
  return {
    async probe(io, nowNs) {
      const source = "intel-drm" as const;
      if (io.platform !== "linux") return { source, state: "absent", detail: "不是 Linux", gpus: [] };
      const cards = (await listDrmCards(io)).filter((c) => c.vendor === "0x8086");
      if (cards.length === 0) return { source, state: "absent", detail: "/sys/class/drm 下沒有 Intel 顯示卡", gpus: [] };
      const usable = [];
      for (const c of cards) if (c.renderNode && (await io.exists(`/dev/dri/${c.renderNode}`))) usable.push(c);
      if (usable.length === 0) {
        prev = null;
        const nodes = cards.map((c) => c.renderNode ?? c.card).join("、");
        return { source, state: "error", detail: `主機有 Intel 顯示卡（${nodes}），但容器裡沒有對應的 /dev/dri 裝置：docker 需要加上 devices: /dev/dri`, gpus: [] };
      }
      const clients = await drmClients(io);
      const before = prev;
      prev = { atNs: nowNs, clients };
      const gpus: GpuReading[] = [];
      for (const c of usable) {
        const mine = clients.filter((x) => x.pdev === c.pdev);
        const util = drmUtilization(before?.clients.filter((x) => x.pdev === c.pdev) ?? null, mine, before ? nowNs - before.atNs : 0);
        const temp = await hwmonTemp(io, c.card);
        gpus.push({
          id: `intel:${c.pdev}`,
          vendor: "intel",
          // the integrated GPU always sits at PCI 00:02.0
          name: c.pdev.endsWith(":00:02.0") ? "Intel 內顯" : "Intel 顯示卡",
          utilPct: util,
          memory: null,
          temperatureC: temp,
          note: null,
          detail: `${c.card}（/dev/dri/${c.renderNode}），PCI ${c.pdev}，裝置 ${c.device}，驅動 ${c.driver}，${mine.length} 個使用中的程式（只計入容器內看得到的程序）`,
        });
      }
      return { source, state: "ok", detail: `${gpus.length} 張`, gpus };
    },
  };
}

/** macOS development machines: Apple GPU utilisation from IOKit, readable without root. */
export async function probeApple(io: MetricsIo): Promise<ProbeOutcome> {
  const source = "apple-ioreg" as const;
  if (io.platform !== "darwin") return { source, state: "absent", detail: "不是 macOS", gpus: [] };
  const r = await io.run(["ioreg", "-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"], 3_000);
  if (r.missing) return { source, state: "absent", detail: "找不到 ioreg", gpus: [] };
  if (r.code !== 0) return { source, state: "error", detail: `ioreg 結束碼 ${r.code}`, gpus: [] };
  const list = parseIoregAccelerator(r.stdout);
  if (list.length === 0) return { source, state: "absent", detail: "IOAccelerator 沒有回報 GPU", gpus: [] };
  return {
    source,
    state: "ok",
    detail: `${list.length} 個`,
    gpus: list.map((g, i) => ({
      id: `apple:${i}`,
      vendor: "apple",
      name: g.model ? `${g.model} 內建 GPU` : "內建 GPU",
      utilPct: g.utilPct,
      memory: null,
      temperatureC: null,
      note: g.utilPct === null ? "這個 GPU 不提供使用率" : null,
      detail: "ioreg IOAccelerator PerformanceStatistics",
    })),
  };
}
