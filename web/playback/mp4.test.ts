import { describe, expect, test } from "bun:test";
import { Mp4Splitter, mimeType, parseMoov, readBoxes } from "./mp4.ts";

const bytes = (...parts: (number[] | Uint8Array)[]) => {
  const flat = parts.flatMap((p) => Array.from(p));
  return new Uint8Array(flat);
};
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u64 = (n: number) => [...u32(Math.floor(n / 2 ** 32)), ...u32(n >>> 0)];
const zeros = (n: number) => new Array<number>(n).fill(0);
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const box = (type: string, ...payload: (number[] | Uint8Array)[]) => {
  const body = bytes(...payload);
  return bytes(u32(body.length + 8), ascii(type), body);
};

const tkhd = (id: number) => box("tkhd", zeros(4), zeros(8), u32(id), zeros(68));
const mdhd = (timescale: number) => box("mdhd", zeros(4), zeros(8), u32(timescale), zeros(8));
const hdlr = (kind: string) => box("hdlr", zeros(4), zeros(4), ascii(kind), zeros(13));
const stsd = (entry: Uint8Array) => box("stsd", zeros(4), u32(1), entry);
const trak = (id: number, timescale: number, kind: string, entry: Uint8Array) =>
  box("trak", tkhd(id), box("mdia", mdhd(timescale), hdlr(kind), box("minf", box("stbl", stsd(entry)))));
const avc1 = (profile: number, compat: number, level: number) => box("avc1", zeros(78), box("avcC", [1, profile, compat, level, 0xff]));
const hvc1 = (cfg: number[]) => box("hvc1", zeros(78), box("hvcC", cfg, zeros(10)));
const mp4a = (aot: number) =>
  box(
    "mp4a",
    zeros(28),
    // esds: ES_Descriptor > DecoderConfigDescriptor (oti 0x40) > DecoderSpecificInfo
    box("esds", zeros(4), [0x03, 0x80, 0x80, 0x80, 25, 0, 1, 0], [0x04, 17, 0x40, 0x15, ...zeros(11)], [0x05, 2, (aot << 3) | 1, 0x90]),
  );
const trex = (id: number, duration: number) => box("trex", zeros(4), u32(id), u32(1), u32(duration), zeros(8));

function moovBytes(...traks: Uint8Array[]) {
  return box("moov", box("mvhd", zeros(100)), ...traks, box("mvex", trex(1, 1000), trex(2, 1024)));
}

function moof(trackId: number, base: number, durations: number[] | { count: number }) {
  const perSample = Array.isArray(durations);
  const tfhdBox = box("tfhd", [0, 0x02, 0, 0], u32(trackId));
  const tfdt = box("tfdt", [1, 0, 0, 0], u64(base));
  const trun = perSample
    ? box("trun", [0, 0, 0x03, 0x01], u32(durations.length), u32(0), ...durations.map((d) => [...u32(d), ...u32(100)]))
    : box("trun", [0, 0, 0x00, 0x01], u32(durations.count), u32(0));
  return box("moof", box("mfhd", zeros(8)), box("traf", tfhdBox, tfdt, trun));
}

const mdat = (n: number) => box("mdat", zeros(n));

describe("codec strings", () => {
  test("H.264 + AAC from avcC and esds", () => {
    const moov = moovBytes(trak(1, 90000, "vide", avc1(0x64, 0x00, 0x1f)), trak(2, 16000, "soun", mp4a(2)));
    const info = parseMoov(moov, readBoxes(moov)[0]!);
    expect(info.tracks.map((t) => [t.id, t.kind, t.timescale, t.codec, t.defaultDuration])).toEqual([
      [1, "video", 90000, "avc1.64001f", 1000],
      [2, "audio", 16000, "mp4a.40.2", 1024],
    ]);
    expect(mimeType(info)).toBe('video/mp4; codecs="avc1.64001f, mp4a.40.2"');
  });

  test("video-only Main profile", () => {
    const moov = moovBytes(trak(1, 90000, "vide", avc1(0x4d, 0x40, 0x28)));
    expect(mimeType(parseMoov(moov, readBoxes(moov)[0]!))).toBe('video/mp4; codecs="avc1.4d4028"');
  });

  test("H.265 Main from hvcC", () => {
    // profile_space 0, tier 0, profile 1, compat flags 0x60000000, constraints 0x90, level 93 (3.1)
    const moov = moovBytes(trak(1, 90000, "vide", hvc1([1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 93])));
    expect(mimeType(parseMoov(moov, readBoxes(moov)[0]!))).toBe('video/mp4; codecs="hvc1.1.6.L93.90"');
  });

  test("H.265 Main 10 high tier", () => {
    const moov = moovBytes(trak(1, 90000, "vide", hvc1([1, 0x22, 0x20, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 120])));
    expect(mimeType(parseMoov(moov, readBoxes(moov)[0]!))).toBe('video/mp4; codecs="hvc1.2.4.H120.b0"');
  });

  test("an unknown sample entry makes the file unplayable", () => {
    const moov = moovBytes(trak(1, 90000, "vide", box("mjpa", zeros(78))));
    expect(mimeType(parseMoov(moov, readBoxes(moov)[0]!))).toBeNull();
  });
});

describe("splitter", () => {
  const init = bytes(box("ftyp", ascii("isom"), zeros(4)), moovBytes(trak(1, 90000, "vide", avc1(0x64, 0, 0x1f)), trak(2, 16000, "soun", mp4a(2))));
  const file = bytes(init, moof(1, 0, [45000, 45000, 90000]), mdat(500), moof(1, 180000, { count: 30 }), mdat(300), box("mfra", zeros(8)));

  test("emits init then timed media units, whatever the chunking", () => {
    for (const size of [1, 7, 64, file.length]) {
      const s = new Mp4Splitter();
      const units = [];
      for (let i = 0; i < file.length; i += size) units.push(...s.push(file.subarray(i, i + size)));
      expect(units.map((u) => u.kind)).toEqual(["init", "media", "media"]);
      expect(units[0]!.bytes).toEqual(init);
      expect(units.slice(1).map((u) => (u.kind === "media" ? u.time : null))).toEqual([
        { start: 0, end: 2 },
        // 30 samples at the trex default of 1000 ticks
        { start: 2, end: 2 + 30_000 / 90000 },
      ]);
      expect(s.received).toBe(file.length);
    }
  });

  test("holds a moof until its mdat is complete, and drops a truncated tail", () => {
    const s = new Mp4Splitter();
    const cut = init.length + moof(1, 0, [45000]).length + 100;
    const first = s.push(file.subarray(0, cut));
    expect(first.map((u) => u.kind)).toEqual(["init"]);
    const rest = s.push(file.subarray(cut, file.length - 400));
    expect(rest.map((u) => u.kind)).toEqual(["media"]);
  });

  test("a fragment without the video track has no time", () => {
    const s = new Mp4Splitter();
    const units = s.push(bytes(init, moof(2, 0, [1024]), mdat(10)));
    expect(units[1]).toMatchObject({ kind: "media", time: null });
  });
});
