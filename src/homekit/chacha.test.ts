import { expect, test } from "bun:test";
import { chacha20Poly1305 } from "./chacha";

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "hex");

// RFC 8439 section 2.8.2
const key = hex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
const nonce = hex("070000004041424344454647");
const aad = hex("50515253c0c1c2c3c4c5c6c7");
const plaintext = Buffer.from(
  "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
);
const expectedCipher = hex(`
  d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6
  3dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b36
  92ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc
  3ff4def08e4b7a9de576d26586cec64b6116`);
const expectedTag = hex("1ae10b594f09e26a7e902ecbd0600691");

test("encrypts the RFC 8439 AEAD vector", () => {
  const cipher = chacha20Poly1305(key, nonce, false).setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext.subarray(0, 50)), cipher.update(plaintext.subarray(50))]);
  cipher.final();
  expect(ct.toString("hex")).toBe(expectedCipher.toString("hex"));
  expect(cipher.getAuthTag().toString("hex")).toBe(expectedTag.toString("hex"));
});

test("decrypts and verifies, and rejects a tampered tag", () => {
  const ok = chacha20Poly1305(key, nonce, true).setAAD(aad).setAuthTag(expectedTag);
  expect(ok.update(expectedCipher).toString()).toBe(plaintext.toString());
  expect(() => ok.final()).not.toThrow();

  const bad = Buffer.from(expectedTag);
  bad[0]! ^= 1;
  const tampered = chacha20Poly1305(key, nonce, true).setAAD(aad).setAuthTag(bad);
  tampered.update(expectedCipher);
  expect(() => tampered.final()).toThrow();
});
