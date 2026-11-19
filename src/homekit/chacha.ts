// ChaCha20-Poly1305 AEAD (RFC 8439). Bun's node:crypto does not ship this cipher,
// and HAP-NodeJS encrypts every session with it, so the homekit worker installs
// this implementation into node:crypto before loading HAP-NodeJS.
import crypto from "node:crypto";
import nacl from "tweetnacl";

// tweetnacl ships Poly1305 only in its untyped lowlevel namespace.
const lowlevel = (nacl as unknown as {
  lowlevel: {
    crypto_onetimeauth(out: Uint8Array, outpos: number, m: Uint8Array, mpos: number, n: number, k: Uint8Array): number;
    crypto_verify_16(x: Uint8Array, xi: number, y: Uint8Array, yi: number): number;
  };
}).lowlevel;

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];

function rotl(v: number, n: number): number {
  return (v << n) | (v >>> (32 - n));
}

function chachaBlock(key: Uint32Array, counter: number, nonce: Uint32Array, out: Uint8Array): void {
  const s = new Uint32Array(16);
  s.set(SIGMA, 0);
  s.set(key, 4);
  s[12] = counter;
  s.set(nonce, 13);
  const x = new Uint32Array(s);
  const qr = (a: number, b: number, c: number, d: number) => {
    x[a] = (x[a]! + x[b]!) | 0; x[d] = rotl(x[d]! ^ x[a]!, 16);
    x[c] = (x[c]! + x[d]!) | 0; x[b] = rotl(x[b]! ^ x[c]!, 12);
    x[a] = (x[a]! + x[b]!) | 0; x[d] = rotl(x[d]! ^ x[a]!, 8);
    x[c] = (x[c]! + x[d]!) | 0; x[b] = rotl(x[b]! ^ x[c]!, 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
  }
  const view = new DataView(out.buffer, out.byteOffset, 64);
  for (let i = 0; i < 16; i++) view.setUint32(i * 4, (x[i]! + s[i]!) >>> 0, true);
}

function words(bytes: Uint8Array): Uint32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = new Uint32Array(bytes.byteLength / 4);
  for (let i = 0; i < w.length; i++) w[i] = view.getUint32(i * 4, true);
  return w;
}

function pad16(n: number): Uint8Array {
  return new Uint8Array((16 - (n % 16)) % 16);
}

function le64(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

class Aead {
  private readonly key: Uint32Array;
  private readonly nonce: Uint32Array;
  private readonly polyKey = new Uint8Array(64);
  private readonly block = new Uint8Array(64);
  private counter = 1;
  private used = 64;
  private aad: Uint8Array = new Uint8Array(0);
  private readonly cipherText: Uint8Array[] = [];
  private cipherLength = 0;
  private tag: Uint8Array | null = null;

  constructor(key: Uint8Array, nonce: Uint8Array, private readonly decrypting: boolean) {
    if (key.byteLength !== 32) throw new Error("Invalid key length");
    if (nonce.byteLength !== 12) throw new Error("Invalid nonce length");
    this.key = words(key);
    this.nonce = words(nonce);
    chachaBlock(this.key, 0, this.nonce, this.polyKey);
  }

  setAAD(aad: Uint8Array): this {
    this.aad = new Uint8Array(aad);
    return this;
  }

  setAuthTag(tag: Uint8Array): this {
    this.tag = new Uint8Array(tag);
    return this;
  }

  getAuthTag(): Buffer {
    if (!this.tag) throw new Error("Auth tag is only available after final()");
    return Buffer.from(this.tag);
  }

  update(data: Uint8Array): Buffer {
    const out = Buffer.alloc(data.byteLength);
    for (let i = 0; i < data.byteLength; i++) {
      if (this.used === 64) {
        chachaBlock(this.key, this.counter++, this.nonce, this.block);
        this.used = 0;
      }
      out[i] = data[i]! ^ this.block[this.used++]!;
    }
    this.cipherText.push(this.decrypting ? new Uint8Array(data) : out);
    this.cipherLength += data.byteLength;
    return out;
  }

  final(): Buffer {
    const mac = Buffer.concat([
      this.aad, pad16(this.aad.byteLength),
      ...this.cipherText, pad16(this.cipherLength),
      le64(this.aad.byteLength), le64(this.cipherLength),
    ]);
    const tag = new Uint8Array(16);
    lowlevel.crypto_onetimeauth(tag, 0, mac, 0, mac.byteLength, this.polyKey.subarray(0, 32));
    if (this.decrypting) {
      if (!this.tag || this.tag.byteLength !== 16 || lowlevel.crypto_verify_16(tag, 0, this.tag, 0) !== 0) {
        throw new Error("Unsupported state or unable to authenticate data");
      }
    } else {
      this.tag = tag;
    }
    return Buffer.alloc(0);
  }
}

export function chacha20Poly1305(key: Uint8Array, nonce: Uint8Array, decrypting: boolean): Aead {
  return new Aead(key, nonce, decrypting);
}

const NAME = "chacha20-poly1305";

export function installChaCha20Poly1305(): void {
  if (crypto.getCiphers().includes(NAME)) return;
  const target = crypto as unknown as Record<string, unknown>;
  const getCiphers = crypto.getCiphers;
  const createCipheriv = crypto.createCipheriv;
  const createDecipheriv = crypto.createDecipheriv;
  target.getCiphers = () => [...getCiphers(), NAME];
  target.createCipheriv = (algorithm: string, key: Uint8Array, iv: Uint8Array, options?: unknown) =>
    algorithm === NAME ? new Aead(key, iv, false) : (createCipheriv as Function)(algorithm, key, iv, options);
  target.createDecipheriv = (algorithm: string, key: Uint8Array, iv: Uint8Array, options?: unknown) =>
    algorithm === NAME ? new Aead(key, iv, true) : (createDecipheriv as Function)(algorithm, key, iv, options);
}
