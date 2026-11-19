// QR Code encoder (ISO/IEC 18004), byte mode, versions 1-10.

export type QrEcc = "L" | "M" | "Q" | "H";

const ECC_INDEX: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };
const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Per version 1..10: [EC codewords per block, block count] for L, M, Q, H.
const BLOCKS: [number, number][][] = [
  [[7, 1], [10, 1], [13, 1], [17, 1]],
  [[10, 1], [16, 1], [22, 1], [28, 1]],
  [[15, 1], [26, 1], [18, 2], [22, 2]],
  [[20, 1], [18, 2], [26, 2], [16, 4]],
  [[26, 1], [24, 2], [18, 4], [22, 4]],
  [[18, 2], [16, 4], [24, 4], [28, 4]],
  [[20, 2], [18, 4], [18, 6], [26, 5]],
  [[24, 2], [22, 4], [22, 6], [26, 6]],
  [[30, 2], [22, 5], [20, 8], [24, 8]],
  [[18, 4], [26, 5], [24, 8], [28, 8]],
];
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const ALIGNMENT: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = EXP[i + 255] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
const gfMul = (a: number, b: number) => (a && b ? EXP[LOG[a]! + LOG[b]!]! : 0);

function rsRemainder(data: number[], ecLen: number): number[] {
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    gen.forEach((c, j) => {
      next[j]! ^= c;
      next[j + 1]! ^= gfMul(c, EXP[i]!);
    });
    gen = next;
  }
  const rem = new Array<number>(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift()!;
    rem.push(0);
    for (let i = 0; i < ecLen; i++) rem[i]! ^= gfMul(gen[i + 1]!, factor);
  }
  return rem;
}

function bchRemainder(value: number, poly: number, dataBits: number): number {
  const polyLen = 31 - Math.clz32(poly);
  let rem = value << polyLen;
  for (let bit = dataBits + polyLen - 1; bit >= polyLen; bit--) {
    if ((rem >> bit) & 1) rem ^= poly << (bit - polyLen);
  }
  return rem;
}

function dataCapacity(version: number, ecc: QrEcc): number {
  const [ecLen, blocks] = BLOCKS[version - 1]![ECC_INDEX[ecc]]!;
  return TOTAL_CODEWORDS[version - 1]! - ecLen * blocks;
}

function buildCodewords(bytes: Uint8Array, version: number, ecc: QrEcc): number[] {
  const capacity = dataCapacity(version, ecc);
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  const [ecLen, blockCount] = BLOCKS[version - 1]![ECC_INDEX[ecc]]!;
  const shortLen = Math.floor(capacity / blockCount);
  const longFrom = blockCount - (capacity % blockCount);
  const dataBlocks: number[][] = [];
  for (let i = 0, pos = 0; i < blockCount; i++) {
    const len = shortLen + (i >= longFrom ? 1 : 0);
    dataBlocks.push(data.slice(pos, pos + len));
    pos += len;
  }
  const ecBlocks = dataBlocks.map((b) => rsRemainder(b, ecLen));
  const out: number[] = [];
  for (let i = 0; i <= shortLen; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]!);
  for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) out.push(b[i]!);
  return out;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0,
];

function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < n; i++) {
    lines.push(m[i]!, m.map((row) => row[i]!));
  }
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    // Finder-like 1:1:3:1:1 pattern with 4 light modules on either side.
    for (let i = 0; i + 11 <= n; i++) {
      const w = line.slice(i, i + 11).map((v) => (v ? 1 : 0)).join("");
      if (w === "10111010000" || w === "00001011101") score += 40;
    }
  }
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v = m[y]![x];
      if (v === m[y]![x + 1] && v === m[y + 1]![x] && v === m[y + 1]![x + 1]) score += 3;
    }
  }
  const dark = m.flat().filter(Boolean).length;
  score += 10 * (Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1);
  return score;
}

export function encodeQr(text: string, ecc: QrEcc = "M"): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  const fits = (v: number) => bytes.length * 8 + 4 + (v <= 9 ? 8 : 16) <= dataCapacity(v, ecc) * 8;
  while (version <= 10 && !fits(version)) version++;
  if (version > 10) throw new Error(`QR payload of ${bytes.length} bytes does not fit version 10 at ECC ${ecc}`);

  const size = 17 + 4 * version;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  let grid = modules;
  const set = (x: number, y: number, dark: boolean) => {
    grid[y]![x] = dark;
    reserved[y]![x] = true;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const align = ALIGNMENT[version - 1]!;
  for (const cy of align) {
    for (const cx of align) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  const writeFormat = (mask: number) => {
    const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
    const bits = ((data << 10) | bchRemainder(data, 0x537, 5)) ^ 0x5412;
    const bit = (i: number) => ((bits >> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  writeFormat(0);
  if (version >= 7) {
    const bits = (version << 12) | bchRemainder(version, 0x1f25, 6);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >> i) & 1) === 1;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  const codewords = buildCodewords(bytes, version, ecc);
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (reserved[y]![x]) continue;
        modules[y]![x] = bitIndex < codewords.length * 8 && (((codewords[bitIndex >> 3] ?? 0) >> (7 - (bitIndex & 7))) & 1) === 1;
        bitIndex++;
      }
    }
  }

  let best: boolean[][] = [];
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    grid = modules.map((row, y) => row.map((v, x) => (reserved[y]![x] ? v : v !== MASKS[mask]!(x, y))));
    writeFormat(mask);
    const score = penalty(grid);
    if (score < bestScore) {
      bestScore = score;
      best = grid;
    }
  }
  return best;
}

// Merges horizontal runs of dark modules into one rect each.
export function qrSvgPath(matrix: boolean[][]): string {
  const parts: string[] = [];
  matrix.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      if (!row[x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end]) end++;
      parts.push(`M${x} ${y}h${end - x}v1h-${end - x}z`);
      x = end;
    }
  });
  return parts.join("");
}
