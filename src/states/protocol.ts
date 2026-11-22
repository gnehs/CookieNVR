import { isMsgCode, msg, type Msg } from "../messages/index.ts";
import { encodeMsg, KIND_JSON } from "../workers/framing.ts";

/** 主程序與狀態辨識 worker（detector/classify.py）之間的訊息，訊框見 workers/framing.ts */
/** 「4 位元組 JSON 長度＋JSON＋二進位」 */
export const KIND_BLOB = 3;

export type ClassifyMode = "force" | "changed";

export interface ClassifyRequest {
  type: "classify";
  id: number;
  sensor: string;
  model: string;
  crop: [number, number, number, number];
  mode: ClassifyMode;
}

export type WorkerJob =
  | { type: "train"; job: number; items: { path: string; label: string }[]; classes: string[]; out: string }
  | { type: "collect"; job: number; ffmpeg: string; points: { path: string; offset: number; at: number }[]; crop: [number, number, number, number]; outDir: string; count: number }
  | { type: "import"; job: number; zip: string; outDir: string };

export type Reading =
  | { kind: "ok"; id: number; label: string; score: number; ms: number; crop: Uint8Array }
  | { kind: "skipped"; id: number }
  | { kind: "error"; id: number; error: string; errorMsg: Msg };

export type WorkerMsg =
  | { type: "loading" }
  | { type: "ready"; backbone: string; loadMs: number }
  | { type: "error"; error: string; errorMsg: Msg; detail: string | null }
  | { type: "heartbeat"; busyMs: number | null; job: boolean }
  | { type: "reading"; reading: Reading }
  | { type: "job-progress"; job: number; progress: number }
  | { type: "job-result"; job: number; ok: true; result: Record<string, unknown> }
  | { type: "job-result"; job: number; ok: false; error: string; errorMsg: Msg };

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeClassify(req: ClassifyRequest, jpeg: Uint8Array): Uint8Array {
  const head = enc.encode(JSON.stringify(req));
  const body = new Uint8Array(4 + head.length + jpeg.length);
  new DataView(body.buffer).setUint32(0, head.length);
  body.set(head, 4);
  body.set(jpeg, 4 + head.length);
  return encodeMsg(KIND_BLOB, body);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** worker 回報的文字：帶了認得的 code 就用，否則當原文 */
function workerMsg(v: Obj, text: string): Msg {
  return isMsgCode(v.code) ? ({ code: v.code, params: isObj(v.params) ? v.params : undefined } as Msg) : msg("raw", { text });
}

/** 解析 worker 的一則訊息；不認得的回 null */
export function parseWorkerMsg(kind: number, payload: Uint8Array): WorkerMsg | null {
  let v: unknown;
  let blob: Uint8Array | null = null;
  try {
    if (kind === KIND_BLOB) {
      const n = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0);
      v = JSON.parse(dec.decode(payload.subarray(4, 4 + n)));
      blob = payload.slice(4 + n);
    } else if (kind === KIND_JSON) {
      v = JSON.parse(dec.decode(payload));
    } else return null;
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  switch (v.type) {
    case "status":
      if (v.state === "loading") return { type: "loading" };
      if (v.state === "ready") return { type: "ready", backbone: String(v.backbone ?? ""), loadMs: num(v.loadMs) ?? 0 };
      if (v.state === "error") {
        const error = String(v.error ?? "未知錯誤");
        return { type: "error", error, errorMsg: workerMsg(v, error), detail: typeof v.detail === "string" ? v.detail : null };
      }
      return null;
    case "heartbeat":
      return { type: "heartbeat", busyMs: num(v.busyMs), job: v.job === true };
    case "reading": {
      const id = num(v.id);
      if (id === null) return null;
      if (typeof v.error === "string") return { type: "reading", reading: { kind: "error", id, error: v.error, errorMsg: workerMsg(v, v.error) } };
      if (v.skipped) return { type: "reading", reading: { kind: "skipped", id } };
      const score = num(v.score);
      if (typeof v.label !== "string" || score === null || !blob) return null;
      return { type: "reading", reading: { kind: "ok", id, label: v.label, score, ms: num(v.ms) ?? 0, crop: blob } };
    }
    case "job-progress": {
      const job = num(v.job);
      const progress = num(v.progress);
      return job === null || progress === null ? null : { type: "job-progress", job, progress };
    }
    case "job-result": {
      const job = num(v.job);
      if (job === null) return null;
      if (v.ok === true && isObj(v.result)) return { type: "job-result", job, ok: true, result: v.result };
      const error = String(v.error ?? "未知錯誤");
      return { type: "job-result", job, ok: false, error, errorMsg: workerMsg(v, error) };
    }
    default:
      return null;
  }
}
