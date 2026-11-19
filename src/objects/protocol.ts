import type { BenchmarkResultDto, GpuUsageDto, InferenceDeviceDto, InferenceDeviceKind } from "../api-types.ts";
import type { Detection } from "./hits.ts";

/** detector 與主程序之間的 Unix socket：「1 位元組種類＋4 位元組長度＋內容」，見 detector/main.py */
export const KIND_JSON = 1;
export const KIND_FRAME = 2;

export interface ReadyInfo {
  device: InferenceDeviceDto;
  /** 這個環境偵測到的所有裝置 */
  devices: InferenceDeviceDto[];
  fallback: { reason: string; detail: string } | null;
  /** classes 是類別鍵、titles 是模型裡的原名，一一對應 */
  model: { file: string; format: string; input: [number, number]; classes: string[]; titles: string[] };
  loadMs: number;
  providers: string[];
  threads: number;
  /** 每個嘗試過的裝置，原樣放進診斷資訊 */
  attempts: unknown[];
  probe: unknown;
}

export type DetectorMsg =
  | { type: "loading" }
  | { type: "ready"; info: ReadyInfo }
  | { type: "error"; error: string; detail: string | null; probe: unknown }
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

function benchResult(v: unknown): BenchmarkResultDto | null {
  if (!isObj(v) || typeof v.device !== "string") return null;
  const kind = DEVICES.has(v.kind as InferenceDeviceKind) ? (v.kind as InferenceDeviceKind) : "cpu";
  const out: BenchmarkResultDto = { device: v.device, kind, name: text(v.name, v.device), ok: v.ok === true };
  if (typeof v.error === "string") out.error = v.error;
  for (const k of ["loadMs", "frames", "fps", "msMean", "msP90"] as const) {
    const n = num(v[k]);
    if (n !== null) out[k] = n;
  }
  return out;
}

function ready(v: Obj): ReadyInfo | null {
  const kind = v.device as InferenceDeviceKind;
  const model = isObj(v.model) ? v.model : null;
  if (!DEVICES.has(kind) || !model) return null;
  const id = typeof v.deviceId === "string" ? v.deviceId : kind;
  const input = Array.isArray(model.input) && model.input.length === 2 ? (model.input.map((n) => num(n) ?? 0) as [number, number]) : ([0, 0] as [number, number]);
  const fb = isObj(v.fallback) ? { reason: text(v.fallback.reason), detail: text(v.fallback.detail) } : null;
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
      if (v.state === "error") return { type: "error", error: text(v.error, "模型載入失敗"), detail: typeof v.detail === "string" ? v.detail : null, probe: v.probe ?? null };
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

export function encodeJson(msg: object): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(msg));
  const out = new Uint8Array(5 + body.length);
  out[0] = KIND_JSON;
  new DataView(out.buffer).setUint32(1, body.length);
  out.set(body, 5);
  return out;
}

export function encodeFrame(id: number, jpeg: Uint8Array): Uint8Array {
  const out = new Uint8Array(9 + jpeg.length);
  const view = new DataView(out.buffer);
  out[0] = KIND_FRAME;
  view.setUint32(1, 4 + jpeg.length);
  view.setUint32(5, id);
  out.set(jpeg, 9);
  return out;
}
