/** 最小的 DNS 訊息編碼與解析，只涵蓋 mDNS 服務廣播用到的紀錄型別（RFC 1035、RFC 6762、RFC 6763）。 */

export const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, NSEC: 47, ANY: 255 } as const;

const CLASS_IN = 1;
/** 問題的 QCLASS 最高位元：要求單播回應；紀錄的 CLASS 最高位元：cache-flush（RFC 6762 §5.4、§10.2） */
const TOP_BIT = 0x8000;
const FLAG_RESPONSE = 0x8000;
const FLAG_AUTHORITATIVE = 0x0400;
const MAX_NAME_JUMPS = 32;
/** RFC 6762 §17：mDNS 封包不超過 9000 bytes；名稱最長 255 bytes（RFC 1035 §2.3.4） */
export const MAX_PACKET_BYTES = 9000;
const MAX_NAME_BYTES = 255;
/** 每一段的筆數上限：正常查詢不到十筆，擋住用大量指標灌爆解析時間的封包 */
const MAX_SECTION_COUNT = 64;

interface RecordBase {
  name: string;
  ttl: number;
  cacheFlush: boolean;
}

export type DnsRecord =
  | (RecordBase & { type: "A"; address: string })
  | (RecordBase & { type: "PTR"; target: string })
  | (RecordBase & { type: "SRV"; priority: number; weight: number; port: number; target: string })
  | (RecordBase & { type: "TXT"; entries: string[] })
  | (RecordBase & { type: "OTHER"; code: number });

export interface DnsQuestion {
  name: string;
  type: number;
  unicastResponse: boolean;
}

export interface DnsMessage {
  id: number;
  isResponse: boolean;
  questions: DnsQuestion[];
  answers: DnsRecord[];
  additionals: DnsRecord[];
}

export class DnsParseError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/** DNS 名稱不分大小寫（只比較 ASCII），比對前先正規化 */
export function sameName(a: string, b: string): boolean {
  return a.replace(/\.$/, "").toLowerCase() === b.replace(/\.$/, "").toLowerCase();
}

class Writer {
  private bytes: number[] = [];

  u8(v: number) {
    this.bytes.push(v & 0xff);
  }
  u16(v: number) {
    this.bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  u32(v: number) {
    this.u16((v >>> 16) & 0xffff);
    this.u16(v & 0xffff);
  }
  raw(b: Uint8Array) {
    for (const x of b) this.bytes.push(x);
  }
  get length() {
    return this.bytes.length;
  }
  patchU16(at: number, v: number) {
    this.bytes[at] = (v >> 8) & 0xff;
    this.bytes[at + 1] = v & 0xff;
  }
  name(name: string) {
    for (const label of name.replace(/\.$/, "").split(".")) {
      if (label === "") continue;
      const b = encoder.encode(label);
      if (b.length > 63) throw new RangeError(`DNS label too long: ${label}`);
      this.u8(b.length);
      this.raw(b);
    }
    this.u8(0);
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function writeRecord(w: Writer, r: DnsRecord): void {
  if (r.type === "OTHER") throw new TypeError("cannot encode an unknown record type");
  w.name(r.name);
  w.u16(TYPE[r.type]);
  w.u16(CLASS_IN | (r.cacheFlush ? TOP_BIT : 0));
  w.u32(r.ttl);
  const lengthAt = w.length;
  w.u16(0);
  const start = w.length;
  switch (r.type) {
    case "A":
      for (const part of r.address.split(".")) w.u8(Number(part));
      break;
    case "PTR":
      w.name(r.target);
      break;
    case "SRV":
      w.u16(r.priority);
      w.u16(r.weight);
      w.u16(r.port);
      w.name(r.target);
      break;
    case "TXT":
      // 空的 TXT 仍須有一個長度為 0 的字串（RFC 6763 §6.1）
      if (r.entries.length === 0) w.u8(0);
      for (const entry of r.entries) {
        const b = encoder.encode(entry);
        if (b.length > 255) throw new RangeError("TXT entry too long");
        w.u8(b.length);
        w.raw(b);
      }
      break;
  }
  w.patchU16(lengthAt, w.length - start);
}

/** 名稱不壓縮：封包很小，省下壓縮的複雜度 */
export function encodeMessage(msg: DnsMessage): Uint8Array {
  const w = new Writer();
  w.u16(msg.id);
  w.u16(msg.isResponse ? FLAG_RESPONSE | FLAG_AUTHORITATIVE : 0);
  w.u16(msg.questions.length);
  w.u16(msg.answers.length);
  w.u16(0);
  w.u16(msg.additionals.length);
  for (const q of msg.questions) {
    w.name(q.name);
    w.u16(q.type);
    w.u16(CLASS_IN | (q.unicastResponse ? TOP_BIT : 0));
  }
  for (const r of msg.answers) writeRecord(w, r);
  for (const r of msg.additionals) writeRecord(w, r);
  return w.done();
}

class Reader {
  offset = 0;
  constructor(private readonly buf: Uint8Array) {}

  private need(n: number, at = this.offset) {
    if (at + n > this.buf.length) throw new DnsParseError("truncated packet");
  }
  u8(): number {
    this.need(1);
    return this.buf[this.offset++]!;
  }
  u16(): number {
    this.need(2);
    const v = (this.buf[this.offset]! << 8) | this.buf[this.offset + 1]!;
    this.offset += 2;
    return v;
  }
  u32(): number {
    return this.u16() * 0x10000 + this.u16();
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const b = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return b;
  }
  /** 支援名稱壓縮指標；指標只能往前指、總長不超過 255 bytes，惡意封包不會造成迴圈或大量運算 */
  name(): string {
    const labels: string[] = [];
    let at = this.offset;
    let jumped = false;
    let bytes = 0;
    for (let jumps = 0; ; ) {
      this.need(1, at);
      const len = this.buf[at]!;
      if (len === 0) {
        if (!jumped) this.offset = at + 1;
        break;
      }
      if ((len & 0xc0) === 0xc0) {
        this.need(2, at);
        if (++jumps > MAX_NAME_JUMPS) throw new DnsParseError("name compression loop");
        if (!jumped) this.offset = at + 2;
        jumped = true;
        const target = ((len & 0x3f) << 8) | this.buf[at + 1]!;
        if (target >= at) throw new DnsParseError("forward compression pointer");
        at = target;
        continue;
      }
      if (len > 63) throw new DnsParseError("bad label length");
      bytes += len + 1;
      if (bytes > MAX_NAME_BYTES) throw new DnsParseError("name too long");
      this.need(1 + len, at);
      labels.push(decoder.decode(this.buf.subarray(at + 1, at + 1 + len)));
      at += 1 + len;
    }
    return labels.join(".");
  }
}

const TYPE_NAMES = new Map<number, "A" | "PTR" | "SRV" | "TXT">([
  [TYPE.A, "A"],
  [TYPE.PTR, "PTR"],
  [TYPE.SRV, "SRV"],
  [TYPE.TXT, "TXT"],
]);

function readRecord(r: Reader): DnsRecord {
  const name = r.name();
  const code = r.u16();
  const cls = r.u16();
  const ttl = r.u32();
  const length = r.u16();
  const end = r.offset + length;
  const base = { name, ttl, cacheFlush: (cls & TOP_BIT) !== 0 };
  const kind = TYPE_NAMES.get(code);
  let record: DnsRecord;
  switch (kind) {
    case "A":
      if (length !== 4) throw new DnsParseError("bad A record");
      record = { ...base, type: "A", address: [...r.bytes(4)].join(".") };
      break;
    case "PTR":
      record = { ...base, type: "PTR", target: r.name() };
      break;
    case "SRV":
      record = { ...base, type: "SRV", priority: r.u16(), weight: r.u16(), port: r.u16(), target: r.name() };
      break;
    case "TXT": {
      const entries: string[] = [];
      while (r.offset < end) {
        const n = r.u8();
        if (n > 0) entries.push(decoder.decode(r.bytes(n)));
      }
      record = { ...base, type: "TXT", entries };
      break;
    }
    default:
      r.bytes(length);
      record = { ...base, type: "OTHER", code };
  }
  if (r.offset !== end) throw new DnsParseError("record length mismatch");
  return record;
}

export function decodeMessage(buf: Uint8Array): DnsMessage {
  if (buf.length > MAX_PACKET_BYTES) throw new DnsParseError("packet too large");
  const r = new Reader(buf);
  const id = r.u16();
  const flags = r.u16();
  const qd = r.u16();
  const an = r.u16();
  const ns = r.u16();
  const ar = r.u16();
  if ([qd, an, ns, ar].some((n) => n > MAX_SECTION_COUNT)) throw new DnsParseError("too many records");
  const questions: DnsQuestion[] = [];
  for (let i = 0; i < qd; i++) {
    const name = r.name();
    const type = r.u16();
    const cls = r.u16();
    questions.push({ name, type, unicastResponse: (cls & TOP_BIT) !== 0 });
  }
  const answers: DnsRecord[] = [];
  for (let i = 0; i < an; i++) answers.push(readRecord(r));
  for (let i = 0; i < ns; i++) readRecord(r);
  const additionals: DnsRecord[] = [];
  for (let i = 0; i < ar; i++) additionals.push(readRecord(r));
  return { id, isResponse: (flags & FLAG_RESPONSE) !== 0, questions, answers, additionals };
}
