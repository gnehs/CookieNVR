/**
 * 列出可以做影片硬體解碼／編碼的顯示卡。識別字和物件辨識（detector/engine.py）同一套，
 * 所以同一張卡在「物件辨識」與「影像解碼」兩個選單裡是同一個值：
 * - Nvidia：`nvidia:GPU-<uuid>`（nvidia-smi 的 UUID）；沒有 nvidia-smi 時 `nvidia:<編號>`
 * - Intel：`intel:GPU.<n>`，比照 OpenVINO 的編號：內顯（PCI 00:02.0）固定是 GPU.0，其餘依 PCI 位址
 * - macOS 開發機：`apple:0`（VideoToolbox），只為了在開發機上走通硬體路徑
 */
import { listDrmCards } from "../metrics/gpu.ts";
import type { MetricsIo } from "../metrics/io.ts";
import { normalizePciId } from "../metrics/parse.ts";
import type { DeviceRef } from "../types.ts";
import type { HwApi } from "./commands.ts";

export type VideoDeviceKind = "intel" | "nvidia" | "apple";

export interface VideoDevice {
  id: DeviceRef;
  kind: VideoDeviceKind;
  name: string;
  /** 對應系統資源 `GpuDto.id` 的 `<vendor>:<PCI 位址>`；Apple 是 null */
  pci: string | null;
  api: HwApi;
  /** 找得到卡但容器裡用不了的原因（例如沒掛 /dev/dri），不必試跑就知道結果 */
  blocked: string | null;
}

const NVIDIA_QUERY = ["nvidia-smi", "--query-gpu=index,uuid,pci.bus_id,name", "--format=csv,noheader"];

/** `index, uuid, pci.bus_id, name`；名稱可能含逗號，所以是第三欄以後全部 */
export function parseNvidiaList(text: string): { index: number; uuid: string; pci: string; name: string }[] {
  return text.split("\n").flatMap((line) => {
    const f = line.split(",").map((s) => s.trim());
    const index = Number(f[0]);
    if (f.length < 4 || !f[0] || !Number.isInteger(index) || !/^GPU-[\w-]+$/.test(f[1]!)) return [];
    return [{ index, uuid: f[1]!, pci: normalizePciId(f[2]!), name: f.slice(3).join(", ") }];
  });
}

async function nvidiaDevices(io: MetricsIo): Promise<VideoDevice[]> {
  const r = await io.run(NVIDIA_QUERY, 4_000);
  if (!r.missing && r.code === 0) {
    return parseNvidiaList(r.stdout).map((g) => ({ id: `nvidia:${g.uuid}`, kind: "nvidia", name: g.name, pci: g.pci, api: { type: "cuda", uuid: g.uuid, index: g.index }, blocked: null }));
  }
  // 沒有 nvidia-smi（容器沒有 utility 能力）但驅動在：比照 detector 用編號當識別字
  const nodes = ((await io.readDir("/dev")) ?? []).filter((n) => /^nvidia\d+$/.test(n)).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  return nodes.map((n) => {
    const index = Number(n.slice(6));
    return { id: `nvidia:${index}`, kind: "nvidia", name: `Nvidia 顯示卡 ${index}`, pci: null, api: { type: "cuda", uuid: null, index }, blocked: null };
  });
}

/** 內顯在 PCI 00:02.0（Intel 的固定位置），排第一；其餘依 PCI 位址 */
const intelOrder = (a: string, b: string) => Number(b.endsWith(":00:02.0")) - Number(a.endsWith(":00:02.0")) || a.localeCompare(b);

async function intelDevices(io: MetricsIo): Promise<VideoDevice[]> {
  const cards = (await listDrmCards(io)).filter((c) => c.vendor === "0x8086").sort((a, b) => intelOrder(a.pdev, b.pdev));
  const out: VideoDevice[] = [];
  for (const [i, c] of cards.entries()) {
    const node = `/dev/dri/${c.renderNode ?? "renderD?"}`;
    const present = c.renderNode !== null && (await io.exists(node));
    out.push({
      id: `intel:GPU.${i}`,
      kind: "intel",
      name: c.pdev.endsWith(":00:02.0") ? "Intel 內顯" : "Intel 顯示卡",
      pci: c.pdev,
      api: { type: "vaapi", node },
      blocked: present ? null : `主機有這張 Intel 顯示卡，但容器裡沒有 ${node}：請在容器設定掛入 /dev/dri`,
    });
  }
  return out;
}

export async function listVideoDevices(io: MetricsIo): Promise<VideoDevice[]> {
  if (io.platform === "darwin") return [{ id: "apple:0", kind: "apple", name: "Apple 媒體引擎（VideoToolbox）", pci: null, api: { type: "videotoolbox" }, blocked: null }];
  if (io.platform !== "linux") return [];
  const [nvidia, intel] = await Promise.all([nvidiaDevices(io), intelDevices(io)]);
  return [...nvidia, ...intel];
}
