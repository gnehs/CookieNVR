/**
 * Several cameras' live fMP4 over one HTTP response, so a multi-camera grid holds one connection
 * instead of one per tile (HTTP/1.1 browsers allow only six per host).
 *
 * Frame: u8 kind, u8 camera index (order of the `cameras` query), u32 big-endian payload length, payload.
 */
export const FrameKind = {
  /** fMP4 bytes in stream order; after a `restart` the next data starts with a new init */
  data: 0,
  /** that camera's worker restarted */
  restart: 1,
  /** that camera has no live stream (deleted, disabled, or dropped) */
  gone: 2,
  /** keeps an idle connection open while no camera sends anything */
  ping: 3,
} as const;
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

export interface Frame {
  kind: FrameKind;
  index: number;
  payload: Uint8Array;
}

const HEADER = 6;

export function encodeFrame(kind: FrameKind, index: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(HEADER + payload.length);
  out[0] = kind;
  out[1] = index;
  new DataView(out.buffer).setUint32(2, payload.length);
  out.set(payload, HEADER);
  return out;
}

/** Incremental decoder: push network chunks, get whole frames. */
export class FrameReader {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const dv = new DataView(merged.buffer);
    const frames: Frame[] = [];
    let p = 0;
    while (p + HEADER <= merged.length) {
      const len = dv.getUint32(p + 2);
      if (p + HEADER + len > merged.length) break;
      frames.push({ kind: merged[p] as FrameKind, index: merged[p + 1]!, payload: merged.slice(p + HEADER, p + HEADER + len) });
      p += HEADER + len;
    }
    this.buf = merged.slice(p);
    return frames;
  }
}
