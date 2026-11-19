import type { Database } from "bun:sqlite";
import { defaultSettings, type Settings, type SettingsStore } from "../types.ts";

export function createSettingsStore(db: Database, dataDir: string, recordingsDir?: string): SettingsStore {
  const listeners = new Set<(settings: Settings) => void>();

  function get(): Settings {
    const defaults = defaultSettings(dataDir, recordingsDir);
    const merged: Record<string, unknown> = { ...defaults };
    for (const row of db.query("SELECT key, value FROM settings").all() as { key: string; value: string }[]) {
      if (row.key in merged) merged[row.key] = JSON.parse(row.value);
    }
    // 新增的工作（例如 decode）在舊資料裡沒有，逐項補預設值
    merged.devices = { ...defaults.devices, ...(merged.devices as Settings["devices"]) };
    return merged as unknown as Settings;
  }

  return {
    get,

    update(patch) {
      const defaults = defaultSettings(dataDir, recordingsDir);
      db.transaction(() => {
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined || !(key in defaults)) continue;
          db.query(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          ).run(key, JSON.stringify(value));
        }
      })();
      const settings = get();
      for (const listener of listeners) {
        try {
          listener(settings);
        } catch (err) {
          console.error("[settings-store] subscriber threw", err);
        }
      }
      return settings;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
