/**
 * Just enough ISO-BMFF parsing to feed recorder fMP4 files into MSE:
 * split a byte stream into init (ftyp+moov) and media (moof+mdat) units,
 * derive the codec string, and time each fragment.
 */

export interface Box {
  type: string;
  start: number;
  /** first byte after the header */
  body: number;
  end: number;
}

export type TrackKind = "video" | "audio" | "other";

export interface Track {
  id: number;
  kind: TrackKind;
  timescale: number;
  /** RFC 6381 codec string, null when the sample entry is not one we can name */
  codec: string | null;
  /** trex default sample duration, in timescale units */
  defaultDuration: number;
}

export interface InitInfo {
  tracks: Track[];
}

export interface FragmentTime {
  /** seconds, from the primary track's tfdt */
  start: number;
  /** seconds, start plus the primary track's summed sample durations */
  end: number;
}

export type Unit =
  | { kind: "init"; bytes: Uint8Array; info: InitInfo }
  | { kind: "media"; bytes: Uint8Array; time: FragmentTime | null };

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "mvex", "moof", "traf"]);

const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Complete boxes in [start, end); stops at the first box that does not fit. */
export function readBoxes(b: Uint8Array, start = 0, end = b.length): Box[] {
  const dv = view(b);
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(dv.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) break;
    out.push({ type: fourcc(b, p + 4), start: p, body: p + header, end: p + size });
    p += size;
  }
  return out;
}

function child(b: Uint8Array, parent: Box, type: string): Box | undefined {
  return readBoxes(b, parent.body, parent.end).find((x) => x.type === type);
}

function path(b: Uint8Array, from: Box, ...types: string[]): Box | undefined {
  let cur: Box | undefined = from;
  for (const t of types) {
    if (!cur) return undefined;
    cur = child(b, cur, t);
  }
  return cur;
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

function avcCodec(b: Uint8Array, entry: Box, name: string): string | null {
  // VisualSampleEntry is 78 bytes before its child boxes.
  const avcC = readBoxes(b, entry.body + 78, entry.end).find((x) => x.type === "avcC");
  if (!avcC || avcC.body + 4 > avcC.end) return null;
  return `${name}.${hex2(b[avcC.body + 1]!)}${hex2(b[avcC.body + 2]!)}${hex2(b[avcC.body + 3]!)}`;
}

function reverseBits32(n: number): number {
  let r = 0;
  for (let i = 0; i < 32; i++) {
    r = (r << 1) | (n & 1);
    n >>>= 1;
  }
  return r >>> 0;
}

function hevcCodec(b: Uint8Array, entry: Box, name: string): string | null {
  const hvcC = readBoxes(b, entry.body + 78, entry.end).find((x) => x.type === "hvcC");
  if (!hvcC || hvcC.body + 13 > hvcC.end) return null;
  const p = hvcC.body;
  const dv = view(b);
  const space = b[p + 1]! >> 6;
  const tier = (b[p + 1]! >> 5) & 1;
  const profile = b[p + 1]! & 0x1f;
  const compat = reverseBits32(dv.getUint32(p + 2));
  const constraints = Array.from(b.subarray(p + 6, p + 12));
  while (constraints.length > 0 && constraints[constraints.length - 1] === 0) constraints.pop();
  const level = b[p + 12]!;
  const parts = [
    name,
    `${["", "A", "B", "C"][space]}${profile}`,
    compat.toString(16),
    `${tier ? "H" : "L"}${level}`,
    ...constraints.map((c) => c.toString(16)),
  ];
  return parts.join(".");
}

/** Reads an MPEG-4 descriptor header: [tag, bodyStart, bodyEnd]. */
function descriptor(b: Uint8Array, p: number, end: number): [number, number, number] | null {
  if (p >= end) return null;
  const tag = b[p]!;
  let len = 0;
  let q = p + 1;
  for (let i = 0; i < 4 && q < end; i++) {
    const byte = b[q++]!;
    len = (len << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  return [tag, q, Math.min(end, q + len)];
}

function aacCodec(b: Uint8Array, entry: Box): string {
  const fallback = "mp4a.40.2";
  // AudioSampleEntry is 28 bytes before its child boxes.
  const esds = readBoxes(b, entry.body + 28, entry.end).find((x) => x.type === "esds");
  if (!esds) return fallback;
  const es = descriptor(b, esds.body + 4, esds.end);
  if (!es || es[0] !== 0x03) return fallback;
  let p = es[1] + 2;
  const flags = b[p++]!;
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + b[p]!;
  if (flags & 0x20) p += 2;
  const dc = descriptor(b, p, es[2]);
  if (!dc || dc[0] !== 0x04) return fallback;
  const oti = b[dc[1]]!;
  const dsi = descriptor(b, dc[1] + 13, dc[2]);
  if (oti !== 0x40 || !dsi || dsi[0] !== 0x05 || dsi[1] >= dsi[2]) return `mp4a.${hex2(oti)}`;
  let aot = b[dsi[1]]! >> 3;
  if (aot === 31 && dsi[1] + 1 < dsi[2]) aot = 32 + (((b[dsi[1]]! & 0x07) << 3) | (b[dsi[1] + 1]! >> 5));
  return `mp4a.40.${aot}`;
}

function sampleEntryCodec(b: Uint8Array, entry: Box): string | null {
  switch (entry.type) {
    case "avc1":
    case "avc3":
      return avcCodec(b, entry, entry.type);
    case "hvc1":
    case "hev1":
      return hevcCodec(b, entry, entry.type);
    case "mp4a":
      return aacCodec(b, entry);
    case "Opus":
      return "opus";
    default:
      return null;
  }
}

/** Parses the moov box (given the whole buffer and its Box). */
export function parseMoov(b: Uint8Array, moov: Box): InitInfo {
  const dv = view(b);
  const defaults = new Map<number, number>();
  const mvex = child(b, moov, "mvex");
  if (mvex) {
    for (const trex of readBoxes(b, mvex.body, mvex.end).filter((x) => x.type === "trex")) {
      defaults.set(dv.getUint32(trex.body + 4), dv.getUint32(trex.body + 12));
    }
  }
  const tracks: Track[] = [];
  for (const trak of readBoxes(b, moov.body, moov.end).filter((x) => x.type === "trak")) {
    const tkhd = child(b, trak, "tkhd");
    const mdhd = path(b, trak, "mdia", "mdhd");
    const hdlr = path(b, trak, "mdia", "hdlr");
    const stsd = path(b, trak, "mdia", "minf", "stbl", "stsd");
    if (!tkhd || !mdhd || !hdlr) continue;
    const id = dv.getUint32(tkhd.body + (b[tkhd.body] === 1 ? 20 : 12));
    const timescale = dv.getUint32(mdhd.body + (b[mdhd.body] === 1 ? 20 : 12));
    const handler = fourcc(b, hdlr.body + 8);
    const kind: TrackKind = handler === "vide" ? "video" : handler === "soun" ? "audio" : "other";
    // stsd is a full box followed by an entry count before the sample entries.
    const entry = stsd ? readBoxes(b, stsd.body + 8, stsd.end)[0] : undefined;
    tracks.push({ id, kind, timescale, codec: entry ? sampleEntryCodec(b, entry) : null, defaultDuration: defaults.get(id) ?? 0 });
  }
  return { tracks };
}

/** Track ids and codec strings that MSE needs; null when a playable track has no known codec. */
export function mimeType(info: InitInfo): string | null {
  const playable = info.tracks.filter((t) => t.kind !== "other");
  if (playable.length === 0 || playable.some((t) => t.codec === null)) return null;
  return `video/mp4; codecs="${playable.map((t) => t.codec).join(", ")}"`;
}

function primaryTrack(info: InitInfo): Track | undefined {
  return info.tracks.find((t) => t.kind === "video") ?? info.tracks[0];
}

/** Times a moof against the primary (video, else first) track. */
export function parseMoof(b: Uint8Array, moof: Box, info: InitInfo): FragmentTime | null {
  const track = primaryTrack(info);
  if (!track || track.timescale === 0) return null;
  const dv = view(b);
  for (const traf of readBoxes(b, moof.body, moof.end).filter((x) => x.type === "traf")) {
    const tfhd = child(b, traf, "tfhd");
    if (!tfhd || dv.getUint32(tfhd.body + 4) !== track.id) continue;
    const tfhdFlags = dv.getUint32(tfhd.body) & 0xffffff;
    let q = tfhd.body + 8;
    if (tfhdFlags & 0x01) q += 8;
    if (tfhdFlags & 0x02) q += 4;
    const defaultDuration = tfhdFlags & 0x08 ? dv.getUint32(q) : track.defaultDuration;

    const tfdt = child(b, traf, "tfdt");
    const base = !tfdt ? 0 : b[tfdt.body] === 1 ? Number(dv.getBigUint64(tfdt.body + 4)) : dv.getUint32(tfdt.body + 4);

    let total = 0;
    for (const trun of readBoxes(b, traf.body, traf.end).filter((x) => x.type === "trun")) {
      const flags = dv.getUint32(trun.body) & 0xffffff;
      const count = dv.getUint32(trun.body + 4);
      let p = trun.body + 8;
      if (flags & 0x01) p += 4;
      if (flags & 0x04) p += 4;
      if (!(flags & 0x100)) {
        total += count * defaultDuration;
        continue;
      }
      const stride = 4 * [0x100, 0x200, 0x400, 0x800].filter((f) => flags & f).length;
      for (let i = 0; i < count && p + 4 <= trun.end; i++, p += stride) total += dv.getUint32(p);
    }
    return { start: base / track.timescale, end: (base + total) / track.timescale };
  }
  return null;
}

/**
 * Incremental splitter: push network chunks in, get whole MSE units out.
 * A moof is held until its mdat is complete, so the SourceBuffer parser is never
 * left mid-segment and a file truncated mid-box is simply dropped at its tail.
 */
export class Mp4Splitter {
  private buf = new Uint8Array(0);
  private info: InitInfo | null = null;
  private ftyp: Uint8Array | null = null;
  /** bytes fed in so far */
  received = 0;

  get init(): InitInfo | null {
    return this.info;
  }

  push(chunk: Uint8Array): Unit[] {
    this.received += chunk.length;
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);

    const units: Unit[] = [];
    const boxes = readBoxes(merged);
    let used = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]!;
      if (box.type === "ftyp") {
        this.ftyp = merged.slice(box.start, box.end);
      } else if (box.type === "moov") {
        this.info = parseMoov(merged, box);
        const moov = merged.subarray(box.start, box.end);
        const bytes = new Uint8Array((this.ftyp?.length ?? 0) + moov.length);
        if (this.ftyp) bytes.set(this.ftyp);
        bytes.set(moov, this.ftyp?.length ?? 0);
        units.push({ kind: "init", bytes, info: this.info });
      } else if (box.type === "moof") {
        const mdat = boxes[i + 1];
        if (!mdat) break;
        if (this.info && mdat.type === "mdat") {
          units.push({ kind: "media", bytes: merged.slice(box.start, mdat.end), time: parseMoof(merged, box, this.info) });
        }
        i++;
        used = mdat.end;
        continue;
      }
      used = box.end;
    }
    this.buf = merged.slice(used);
    return units;
  }
}
