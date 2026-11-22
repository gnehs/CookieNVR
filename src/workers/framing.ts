/** 主程序與 worker 之間的訊框（detect worker 的 stdout、detector 與 classify 的 Unix socket）：1 位元組種類 + 4 位元組長度（big-endian）+ 內容 */

/** 種類 1 在 detector 與 classify 都是一則 JSON；其他種類各協定自己定 */
export const KIND_JSON = 1;

export function encodeMsg(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
}

const enc = new TextEncoder();

export const encodeJson = (msg: object) => encodeMsg(KIND_JSON, enc.encode(JSON.stringify(msg)));

/** 把任意切開的位元組流拆回訊息 */
export class MsgReader {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): { kind: number; payload: Uint8Array<ArrayBuffer> }[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const out: { kind: number; payload: Uint8Array<ArrayBuffer> }[] = [];
    let p = 0;
    while (merged.length - p >= 5) {
      const len = new DataView(merged.buffer, p + 1, 4).getUint32(0);
      if (merged.length - p - 5 < len) break;
      out.push({ kind: merged[p]!, payload: merged.slice(p + 5, p + 5 + len) });
      p += 5 + len;
    }
    this.buf = merged.slice(p);
    return out;
  }
}
