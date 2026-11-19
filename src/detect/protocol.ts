import type { DetectFrameState } from "../api-types.ts";
import type { MaskPolygon } from "../types.ts";

/**
 * 主程序寫給 detect worker 的控制檔（JSON）。worker 每張畫面重讀一次，所以改設定、
 * 鏡頭移動都不用重啟 worker。supervisor 不給 worker stdin，控制檔是唯一的下行通道。
 */
export interface DetectControl {
  /** false：只解碼供快照，不做差分 */
  diff: boolean;
  threshold: number;
  minArea: number;
  masks: MaskPolygon[];
  /** 鏡頭移動中；從 true 變回 false 時重設背景 */
  paused: boolean;
  /** 有人在設定頁看「畫面變化」：每張畫面多算各靈敏度下的分數 */
  preview: boolean;
}

export const IDLE_CONTROL: DetectControl = { diff: false, threshold: 25, minArea: 0.005, masks: [], paused: false, preview: false };

export function parseControl(text: string): DetectControl | null {
  try {
    const v = JSON.parse(text) as Partial<DetectControl>;
    if (typeof v !== "object" || v === null) return null;
    return {
      diff: v.diff === true,
      threshold: typeof v.threshold === "number" ? v.threshold : IDLE_CONTROL.threshold,
      minArea: typeof v.minArea === "number" ? v.minArea : IDLE_CONTROL.minArea,
      masks: Array.isArray(v.masks) ? v.masks : [],
      paused: v.paused === true,
      preview: v.preview === true,
    };
  } catch {
    return null;
  }
}

/** worker stdout 的訊息：1 位元組種類 + 4 位元組長度（big-endian）+ 內容 */
export const enum MsgKind {
  /** JSON 的 FrameResult */
  frame = 1,
  /** 一張 JPEG */
  jpeg = 2,
  /** JSON 的 DecodeReport，硬體解碼開始運作或退回 CPU 時各送一次 */
  decode = 3,
}

/** hw：第一張畫面已經由顯示卡解出；cpu：顯示卡啟動失敗，這次執行改用 CPU（reason 是白話，detail 是 ffmpeg 的訊息） */
export type DecodeReport = { mode: "hw"; deviceId: string } | { mode: "cpu"; reason: string; detail: string };

export interface FrameResult {
  at: number;
  state: DetectFrameState;
  score: number | null;
  motion: boolean;
  /** 控制檔要求預覽、而且 state 是 ok 時：`PREVIEW_THRESHOLDS` 各門檻下的分數 */
  curve?: number[];
}

export type WorkerMsg = { kind: "frame"; result: FrameResult } | { kind: "jpeg"; at: number; bytes: Uint8Array };

export function encodeMsg(kind: MsgKind, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
}

/** 把任意切開的位元組流拆回訊息 */
export class MsgReader {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): { kind: MsgKind; payload: Uint8Array<ArrayBuffer> }[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const out: { kind: MsgKind; payload: Uint8Array<ArrayBuffer> }[] = [];
    let p = 0;
    while (merged.length - p >= 5) {
      const len = new DataView(merged.buffer, p + 1, 4).getUint32(0);
      if (merged.length - p - 5 < len) break;
      out.push({ kind: merged[p] as MsgKind, payload: merged.slice(p + 5, p + 5 + len) });
      p += 5 + len;
    }
    this.buf = merged.slice(p);
    return out;
  }
}

/** 從 image2pipe 的 MJPEG 流切出完整的 JPEG（SOI 到 EOI；ffmpeg 不嵌縮圖，EOI 不會出現在中間） */
export class JpegSplitter {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const out: Uint8Array[] = [];
    let start = -1;
    let i = 0;
    let consumed = 0;
    for (; i + 1 < merged.length; i++) {
      if (merged[i] !== 0xff) continue;
      const m = merged[i + 1];
      if (m === 0xd8 && start < 0) start = i;
      else if (m === 0xd9 && start >= 0) {
        out.push(merged.slice(start, i + 2));
        consumed = i + 2;
        start = -1;
        i++;
      }
    }
    this.buf = merged.slice(start >= 0 ? start : consumed);
    return out;
  }
}

export async function* chunksOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
