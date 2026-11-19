import { expect, test } from "bun:test";
import { isLocalAddress } from "./link-address.ts";

test("home-network addresses are local, anything else gets a warning", () => {
  for (const ip of ["192.168.1.20", "10.0.0.5", "172.16.3.4", "172.31.0.1", "127.0.0.1", "169.254.1.1", "::1", "fd12::1", "fe80::1"]) {
    expect(isLocalAddress(ip)).toBe(true);
  }
  for (const ip of ["8.8.8.8", "172.32.0.1", "100.64.1.1", "2001:db8::1", "unknown"]) expect(isLocalAddress(ip)).toBe(false);
});
