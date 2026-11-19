import { expect, test } from "bun:test";
import { encodeQr, qrSvgPath } from "./qr";

const HOMEKIT = "X-HM://00GW95DQACNVR";

// Verified decodable (macOS CIDetector QR) when generated.
const GOLDEN = [
  "1111111011100011001111111",
  "1000001001001110101000001",
  "1011101011111110101011101",
  "1011101001101010001011101",
  "1011101001101101001011101",
  "1000001010110110101000001",
  "1111111010101010101111111",
  "0000000001001000000000000",
  "1010001100111101100100101",
  "0001010000011010100100100",
  "0101001000011011001111101",
  "0110010101111000011001010",
  "0010011111010111001001100",
  "0010100000000100110001101",
  "1100011100010001101110111",
  "0001100101000100111000000",
  "1110111010011101111110010",
  "0000000011101000100010110",
  "1111111010101111101011001",
  "1000001001111011100010000",
  "1011101001100111111111001",
  "1011101001100111000111110",
  "1011101010110000100110011",
  "1000001000000101101110000",
  "1111111010111101101001001",
];

// Cell lookup that fails the test (instead of returning undefined) when out of range.
const cell = (m: boolean[][], x: number, y: number): boolean => m[y]![x]!;
const toRows = (m: boolean[][]) => m.map((r) => r.map((v) => (v ? "1" : "0")).join(""));

test("HomeKit payload at ECC M matches the golden matrix", () => {
  expect(toRows(encodeQr(HOMEKIT, "M"))).toEqual(GOLDEN);
});

test("size is 17 + 4 * version and grows with payload", () => {
  expect(encodeQr("A").length).toBe(21);
  expect(encodeQr(HOMEKIT).length).toBe(25);
  expect(encodeQr("x".repeat(150), "L").length).toBe(45);
  expect(encodeQr("x".repeat(200), "M").length).toBe(57);
});

test("finder patterns, separators, timing and dark module", () => {
  for (const text of ["A", HOMEKIT, "x".repeat(150)]) {
    const m = encodeQr(text, "M");
    const n = m.length;
    for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]] as [number, number][]) {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          expect(cell(m, ox + dx, oy + dy)).toBe(d !== 2);
        }
      }
    }
    for (let i = 8; i < n - 8; i++) {
      expect(cell(m, i, 6)).toBe(i % 2 === 0);
      expect(cell(m, 6, i)).toBe(i % 2 === 0);
    }
    expect(cell(m, 8, n - 8)).toBe(true);
  }
});

test("format bits are valid and encode the requested ECC level", () => {
  const eccBits = { L: 1, M: 0, Q: 3, H: 2 } as const;
  for (const ecc of ["L", "M", "Q", "H"] as const) {
    const m = encodeQr(HOMEKIT, ecc);
    const n = m.length;
    let bits = 0;
    for (let i = 0; i < 15; i++) {
      const dark = i < 6 ? cell(m, 8, i) : i === 6 ? cell(m, 8, 7) : i === 7 ? cell(m, 8, 8) : i === 8 ? cell(m, 7, 8) : cell(m, 14 - i, 8);
      if (dark) bits |= 1 << i;
    }
    // Second copy must agree with the first.
    let copy = 0;
    for (let i = 0; i < 15; i++) {
      const dark = i < 8 ? cell(m, n - 1 - i, 8) : cell(m, 8, n - 15 + i);
      if (dark) copy |= 1 << i;
    }
    expect(copy).toBe(bits);
    const unmasked = bits ^ 0x5412;
    const data = unmasked >> 10;
    expect(data >> 3).toBe(eccBits[ecc]);
    // BCH(15,5) check: the codeword is divisible by the generator 0x537.
    let rem = unmasked;
    for (let b = 14; b >= 10; b--) if ((rem >> b) & 1) rem ^= 0x537 << (b - 10);
    expect(rem).toBe(0);
  }
});

test("version info is present from version 7", () => {
  const m = encodeQr("x".repeat(150), "L");
  const n = m.length;
  let bits = 0;
  for (let i = 0; i < 18; i++) if (cell(m, n - 11 + (i % 3), Math.floor(i / 3))) bits |= 1 << i;
  expect(bits >> 12).toBe(7);
  let rem = bits;
  for (let b = 17; b >= 12; b--) if ((rem >> b) & 1) rem ^= 0x1f25 << (b - 12);
  expect(rem).toBe(0);
});

test("payloads beyond version 10 throw", () => {
  expect(() => encodeQr("y".repeat(120), "H")).toThrow(/does not fit/);
  expect(() => encodeQr("y".repeat(300), "L")).toThrow(/does not fit/);
  expect(encodeQr("y".repeat(119), "H").length).toBe(57);
});

test("UTF-8 text is encoded by byte length", () => {
  // 10 CJK characters are 30 bytes, which no longer fits version 2 at ECC M.
  expect(encodeQr("餅".repeat(10)).length).toBe(29);
  expect(encodeQr("餅".repeat(4)).length).toBe(21);
});

test("svg path covers exactly the dark modules", () => {
  const m = encodeQr(HOMEKIT);
  const path = qrSvgPath(m);
  const covered = m.map((r) => r.map(() => false));
  for (const [, x, y, w] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < Number(w); i++) covered[Number(y)]![Number(x) + i] = true;
  }
  expect(covered).toEqual(m);
});
