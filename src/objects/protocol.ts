import type { BenchmarkResultDto, GpuUsageDto, InferenceDeviceDto, InferenceDeviceKind } from "../api-types.ts";
import { msg, type Msg } from "../messages/index.ts";
import { externalMsg, msgOrRaw } from "../messages/external.ts";
import { encodeMsg } from "../workers/framing.ts";
import type { Detection } from "./hits.ts";

/** detector 與主程序之間的 Unix socket，訊框見 workers/framing.ts、detector/main.py；種類 2 是「4 位元組影格編號＋JPEG」 */
const KIND_FRAME = 2;

export interface ReadyInfo {
  device: InferenceDeviceDto;
  /** 這個環境偵測到的所有裝置 */
  devices: InferenceDeviceDto[];
  fallback: { reason: string; detail: string; reasonMsg: Msg } | null;
  /** classes 是類別鍵、titles 是模型裡的原名，一一對應 */
  model: { file: string; format: string; input: [number, number]; classes: string[]; titles: string[] };
  loadMs: number;
  providers: string[];
  /** 各 provider 實際佔的推論時間比例（{"CUDAExecutionProvider": 0.99, ...}）；量不到為 null */
  placement: Record<string, number> | null;
  threads: number;
  /** 每個嘗試過的裝置，原樣放進診斷資訊 */
  attempts: unknown[];
  probe: unknown;
}

export type DetectorMsg =
  | { type: "loading" }
  | { type: "ready"; info: ReadyInfo }
  | { type: "error"; error: string; errorMsg: Msg; detail: string | null; probe: unknown }
  | { type: "heartbeat"; busyMs: number | null; bench: boolean; gpu: GpuUsageDto | null }
  | { type: "result"; id: number; ms: number; detections: Detection[] }
  | { type: "result-error"; id: number; error: string }
  | { type: "bench-progress"; device: string; fraction: number; index: number; total: number }
  | { type: "bench-result"; cancelled: boolean; results: BenchmarkResultDto[] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const DEVICES = new Set<InferenceDeviceKind>(["cpu", "intel", "nvidia"]);

function detection(v: unknown): Detection | null {
  if (!isObj(v) || typeof v.label !== "string") return null;
  const score = num(v.score);
  const box = Array.isArray(v.box) && v.box.length === 4 && v.box.every((n) => num(n) !== null) ? (v.box as [number, number, number, number]) : null;
  return score === null || box === null ? null : { label: v.label, score, box };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function device(v: unknown): InferenceDeviceDto | null {
  if (!isObj(v) || typeof v.id !== "string" || !DEVICES.has(v.kind as InferenceDeviceKind)) return null;
  return { id: v.id, kind: v.kind as InferenceDeviceKind, name: text(v.name, v.id), pci: typeof v.pci === "string" ? v.pci : null };
}

function gpu(v: unknown): GpuUsageDto | null {
  if (!isObj(v)) return null;
  const util = num(v.utilPercent);
  const used = num(v.memoryUsedMb);
  const total = num(v.memoryTotalMb);
  return util === null || used === null || total === null ? null : { utilPercent: util, memoryUsedMb: used, memoryTotalMb: total };
}

function placement(v: unknown): Record<string, number> | null {
  if (!isObj(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, share] of Object.entries(v)) {
    const n = num(share);
    if (n !== null) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

/** GPU 上的推論有多少比例其實在 CPU EP 上跑；CPU 裝置或量不到為 null */
export function cpuShareOf(kind: InferenceDeviceKind, shares: Record<string, number> | null): number | null {
  return kind === "cpu" || !shares ? null : (shares.CPUExecutionProvider ?? 0);
}

function benchResult(v: unknown): BenchmarkResultDto | null {
  if (!isObj(v) || typeof v.device !== "string") return null;
  const kind = DEVICES.has(v.kind as InferenceDeviceKind) ? (v.kind as InferenceDeviceKind) : "cpu";
  const out: BenchmarkResultDto = { device: v.device, kind, name: text(v.name, v.device), ok: v.ok === true };
  if (typeof v.reason === "string") {
    out.reason = v.reason;
    out.reasonMsg = msgOrRaw(v.reasonMsg, v.reason);
  }
  if (typeof v.error === "string") {
    out.error = v.error;
    // 技術訊息多半沒有 code；只有 detector 自己說得出的原因（例如找不到裝置）才有
    if (isObj(v.errorMsg)) out.errorMsg = msgOrRaw(v.errorMsg, v.error);
  }
  for (const k of ["loadMs", "frames", "fps", "msMean", "msP90"] as const) {
    const n = num(v[k]);
    if (n !== null) out[k] = n;
  }
  const share = cpuShareOf(kind, placement(v.placement));
  if (share !== null) out.cpuShare = share;
  return out;
}

function ready(v: Obj): ReadyInfo | null {
  const kind = v.device as InferenceDeviceKind;
  const model = isObj(v.model) ? v.model : null;
  if (!DEVICES.has(kind) || !model) return null;
  const id = typeof v.deviceId === "string" ? v.deviceId : kind;
  const input = Array.isArray(model.input) && model.input.length === 2 ? (model.input.map((n) => num(n) ?? 0) as [number, number]) : ([0, 0] as [number, number]);
  const fb = isObj(v.fallback) ? { reason: text(v.fallback.reason), detail: text(v.fallback.detail), reasonMsg: externalMsg(v.fallback.code, v.fallback.params, text(v.fallback.reason)) } : null;
  const devices = Array.isArray(v.devices) ? v.devices.map(device).filter((d): d is InferenceDeviceDto => d !== null) : [];
  const classes = strings(model.classes);
  const titles = strings(model.titles);
  return {
    device: devices.find((d) => d.id === id) ?? { id, kind, name: text(v.deviceName, id), pci: null },
    devices,
    fallback: fb,
    model: { file: text(model.file), format: text(model.format), input, classes, titles: titles.length === classes.length ? titles : classes },
    loadMs: num(v.loadMs) ?? 0,
    providers: Array.isArray(v.providers) ? v.providers.filter((p): p is string => typeof p === "string") : [],
    placement: placement(v.placement),
    threads: num(v.threads) ?? 0,
    attempts: Array.isArray(v.attempts) ? v.attempts : [],
    probe: v.probe ?? null,
  };
}

/** detector 送來的 JSON；看不懂的訊息回 null（忽略，不讓一個怪訊息弄壞主程序） */
export function parseDetectorMsg(raw: string): DetectorMsg | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  switch (v.type) {
    case "status":
      if (v.state === "loading") return { type: "loading" };
      if (v.state === "error") {
        const error = text(v.error, "模型載入失敗");
        const errorMsg = typeof v.error === "string" ? externalMsg(v.code, v.params, error) : msg("detector.modelLoadFailed");
        return { type: "error", error, errorMsg, detail: typeof v.detail === "string" ? v.detail : null, probe: v.probe ?? null };
      }
      if (v.state === "ready") {
        const info = ready(v);
        return info && { type: "ready", info };
      }
      return null;
    case "heartbeat":
      return { type: "heartbeat", busyMs: num(v.busyMs), bench: v.bench === true, gpu: gpu(v.gpu) };
    case "bench-progress":
      return typeof v.device === "string" ? { type: "bench-progress", device: v.device, fraction: num(v.fraction) ?? 0, index: num(v.index) ?? 0, total: num(v.total) ?? 1 } : null;
    case "bench-result":
      return { type: "bench-result", cancelled: v.cancelled === true, results: Array.isArray(v.results) ? v.results.map(benchResult).filter((r): r is BenchmarkResultDto => r !== null) : [] };
    case "result": {
      const id = num(v.id);
      if (id === null) return null;
      if (typeof v.error === "string") return { type: "result-error", id, error: v.error };
      if (!Array.isArray(v.detections)) return null;
      const detections = v.detections.map(detection).filter((d): d is Detection => d !== null);
      return { type: "result", id, ms: num(v.ms) ?? 0, detections };
    }
    default:
      return null;
  }
}

export function encodeFrame(id: number, jpeg: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + jpeg.length);
  new DataView(body.buffer).setUint32(0, id);
  body.set(jpeg, 4);
  return encodeMsg(KIND_FRAME, body);
}
