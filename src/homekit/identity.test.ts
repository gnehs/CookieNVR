import { expect, test } from "bun:test";
import { allocatePort, createIdentity, generatePincode, isValidPincode, setupUri } from "./identity";

test("setup URI matches what HAP-NodeJS published for the same code", () => {
  // Captured from a HAP-NodeJS 0.14.3 accessory: pincode 031-45-154, IP camera, setup id CNVR.
  expect(setupUri("031-45-154", "CNVR")).toBe("X-HM://00GW95DQACNVR");
});

test("setup URI is always 9 payload characters plus the setup id", () => {
  expect(setupUri("000-00-001", "AB12", 1)).toMatch(/^X-HM:\/\/[0-9A-Z]{9}AB12$/);
});

test("rejects codes HomeKit refuses and malformed ones", () => {
  for (const bad of ["000-00-000", "111-11-111", "999-99-999", "123-45-678", "876-54-321", "12345678", "123-456-78"]) {
    expect(isValidPincode(bad)).toBe(false);
  }
  expect(isValidPincode("031-45-154")).toBe(true);
});

test("pincode generation skips invalid codes", () => {
  // First draw maps to 11111111 (invalid), second to 00031454... is valid.
  const draws = [11_111_111, 31_454].map((v) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v);
    return b;
  });
  let i = 0;
  expect(generatePincode(() => draws[i++]!)).toBe("000-31-454");
  for (let n = 0; n < 200; n++) expect(isValidPincode(generatePincode())).toBe(true);
});

test("identity has a locally administered device id and a 4-character setup id", () => {
  const id = createIdentity(52826);
  expect(id.username).toMatch(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
  expect(parseInt(id.username.slice(0, 2), 16) & 0x03).toBe(0x02);
  expect(id.setupId).toMatch(/^[0-9A-Z]{4}$/);
  expect(id.port).toBe(52826);
});

test("ports are handed out upward from the base, filling gaps", () => {
  expect(allocatePort(51826, [])).toBe(51826);
  expect(allocatePort(51826, [51826, 51827, 51829])).toBe(51828);
  expect(allocatePort(65535, [65535])).toBeNull();
});
