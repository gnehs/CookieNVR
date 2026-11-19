import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactDeviceId, createRoutedStore, deviceIdOfKey, isPaired } from "./hap-storage";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

test("routes each accessory's keys into its own camera directory", () => {
  const root = mkdtempSync(join(tmpdir(), "hk-"));
  dirs.push(root);
  const map = new Map([["AABBCCDDEEFF", join(root, "cam1")], ["112233445566", join(root, "cam2")]]);
  const store = createRoutedStore((id) => map.get(id) ?? null);
  store.setItemSync("AccessoryInfo.AABBCCDDEEFF.json", { pairedClients: { phone: "ab" } });
  store.setItemSync("AccessoryInfo.112233445566.json", { pairedClients: {} });
  expect(existsSync(join(root, "cam1", "AccessoryInfo.AABBCCDDEEFF.json"))).toBe(true);
  expect(store.getItem("AccessoryInfo.AABBCCDDEEFF.json")).toEqual({ pairedClients: { phone: "ab" } });
  expect(isPaired(join(root, "cam1"), "AA:BB:CC:DD:EE:FF")).toBe(true);
  expect(isPaired(join(root, "cam2"), "11:22:33:44:55:66")).toBe(false);
  store.removeItemSync("AccessoryInfo.AABBCCDDEEFF.json");
  expect(store.getItem("AccessoryInfo.AABBCCDDEEFF.json")).toBeUndefined();
  expect(() => store.setItemSync("AccessoryInfo.999999999999.json", {})).toThrow();
});

test("device ids", () => {
  expect(deviceIdOfKey("ControllerStorage.AABBCCDDEEFF.json")).toBe("AABBCCDDEEFF");
  expect(deviceIdOfKey("other.json")).toBeNull();
  expect(compactDeviceId("aa:bb:cc:dd:ee:ff")).toBe("AABBCCDDEEFF");
});
