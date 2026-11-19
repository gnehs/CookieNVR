/**
 * HAP-NodeJS keeps all persisted state in one process-wide store, with keys such as
 * "AccessoryInfo.<DEVICEID>.json". CookieNVR wants each camera's pairing data in its own
 * `<dataDir>/homekit/<camera id>/`, so this store routes each key to the directory of the
 * accessory whose device id the key names. Only the three calls HAP-NodeJS makes are implemented.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RoutedStore {
  getItem(key: string): unknown;
  setItemSync(key: string, value: unknown): void;
  removeItemSync(key: string): void;
}

/** "AccessoryInfo.AABBCCDDEEFF.json" → "AABBCCDDEEFF" */
export function deviceIdOfKey(key: string): string | null {
  return /^[A-Za-z]+\.([0-9A-F]{12})\.json$/.exec(key)?.[1] ?? null;
}

export const compactDeviceId = (username: string) => username.replaceAll(":", "").toUpperCase();

/** `dirOf` maps a compact device id to the camera directory, null for unknown accessories. */
export function createRoutedStore(dirOf: (deviceId: string) => string | null): RoutedStore {
  const pathOf = (key: string) => {
    const id = deviceIdOfKey(key);
    const dir = id ? dirOf(id) : null;
    if (!dir) throw new Error(`no HomeKit directory for storage key ${key}`);
    return join(dir, key);
  };
  return {
    getItem(key) {
      try {
        return JSON.parse(readFileSync(pathOf(key), "utf8"));
      } catch {
        return undefined;
      }
    },
    setItemSync(key, value) {
      const path = pathOf(key);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(value));
      renameSync(`${path}.tmp`, path);
    },
    removeItemSync(key) {
      rmSync(pathOf(key), { force: true });
    },
  };
}

/** Whether the accessory stored in `dir` has at least one paired controller. */
export function isPaired(dir: string, username: string): boolean {
  try {
    const info = JSON.parse(readFileSync(join(dir, `AccessoryInfo.${compactDeviceId(username)}.json`), "utf8"));
    return Object.keys(info?.pairedClients ?? {}).length > 0;
  } catch {
    return false;
  }
}
