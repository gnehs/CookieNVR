import type { Database } from "bun:sqlite";
import { join } from "node:path";
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
          // 沒有存 storagePath 就是跟著預設位置走；選回預設位置等於恢復自動，之後掛了 /recordings 才會跟著換
          if (key === "storagePath" && value === defaults.storagePath) {
            db.query("DELETE FROM settings WHERE key = 'storagePath'").run();
            continue;
          }
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

/**
 * 錄影位置存在資料庫裡就是使用者指定的；沒有存就跟著預設（RECORDINGS_DIR、另外掛的 /recordings、
 * 否則 <dataDir>/recordings）。舊版儲存「錄影與儲存」時會把當下的預設值一起存進去，所以存的值若剛好是
 * <dataDir>/recordings、而現在的預設已經是別處，視為沒指定過：刪掉這筆，回傳舊位置給啟動日誌說明。
 */
export function followRecordingsDefault(db: Database, dataDir: string, recordingsDir: string): string | null {
  const fallback = join(dataDir, "recordings");
  if (recordingsDir === fallback) return null;
  const row = db.query("SELECT value FROM settings WHERE key = 'storagePath'").get() as { value: string } | null;
  if (!row || JSON.parse(row.value) !== fallback) return null;
  db.query("DELETE FROM settings WHERE key = 'storagePath'").run();
  return fallback;
}
