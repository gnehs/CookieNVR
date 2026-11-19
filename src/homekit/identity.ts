/**
 * The HomeKit identity of one camera accessory: what Apple calls the accessory's device id
 * (`username`, MAC-shaped), its setup code, setup id and HAP port. Pure functions only, so the
 * main process can show the code and QR payload without loading HAP-NodeJS.
 */

export interface HomekitIdentity {
  /** HAP device id, "AA:BB:CC:DD:EE:FF". A new one makes iOS treat the camera as a new accessory. */
  username: string;
  /** "123-45-678" */
  pincode: string;
  /** Four characters of 0-9A-Z, the tail of the setup URI */
  setupId: string;
  port: number;
}

/** HAP accessory category for an IP camera. */
export const CATEGORY_IP_CAMERA = 17;

/** Codes HomeKit refuses (HAP spec, section 4.2.1.2). */
const INVALID_CODES = new Set([
  ...Array.from({ length: 10 }, (_, d) => String(d).repeat(8)),
  "12345678",
  "87654321",
]);

const SETUP_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

type Random = (n: number) => Uint8Array;
const secureRandom: Random = (n) => crypto.getRandomValues(new Uint8Array(n));

export function isValidPincode(pincode: string): boolean {
  return /^\d{3}-\d{2}-\d{3}$/.test(pincode) && !INVALID_CODES.has(pincode.replaceAll("-", ""));
}

export function generatePincode(random: Random = secureRandom): string {
  for (;;) {
    // 4 bytes give a 32-bit value; rejecting the top slice keeps the 8 digits uniform.
    const v = new DataView(random(4).buffer).getUint32(0);
    if (v >= 4_200_000_000) continue;
    const digits = String(v % 100_000_000).padStart(8, "0");
    const code = `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
    if (isValidPincode(code)) return code;
  }
}

export function generateUsername(random: Random = secureRandom): string {
  const bytes = random(6);
  // Locally administered, unicast: never collides with a real NIC's address.
  bytes[0] = (bytes[0]! & 0xfc) | 0x02;
  return [...bytes].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

export function generateSetupId(random: Random = secureRandom): string {
  let id = "";
  while (id.length < 4) {
    for (const b of random(8)) {
      // 252 = 36 * 7; dropping larger bytes avoids modulo bias.
      if (b < 252 && id.length < 4) id += SETUP_ID_ALPHABET[b % 36];
    }
  }
  return id;
}

/** The QR payload HomeKit scans, same encoding as HAP-NodeJS's `Accessory.setupURI()`. */
export function setupUri(pincode: string, setupId: string, category = CATEGORY_IP_CAMERA): string {
  const code = BigInt(pincode.replaceAll("-", ""));
  const supportsIp = 1n << 28n;
  const payload = (BigInt(category) << 31n) | supportsIp | code;
  return `X-HM://${payload.toString(36).toUpperCase().padStart(9, "0")}${setupId}`;
}

/** First port at or above `base` that is not taken; null when the range is exhausted. */
export function allocatePort(base: number, taken: Iterable<number>, max = 65535): number | null {
  const used = new Set(taken);
  for (let p = base; p <= max; p++) if (!used.has(p)) return p;
  return null;
}

export function createIdentity(port: number, random: Random = secureRandom): HomekitIdentity {
  return { username: generateUsername(random), pincode: generatePincode(random), setupId: generateSetupId(random), port };
}
