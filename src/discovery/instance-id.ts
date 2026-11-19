import type { Database } from "bun:sqlite";

const KEY = "instanceId";

/**
 * 這台 NVR 的穩定識別碼：第一次啟動時產生，存在 settings 表（跟著資料庫備份走）。
 * 不在 `Settings` 型別裡，所以 PUT /api/settings 改不到它。
 */
export function loadInstanceId(db: Database): string {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | null;
  if (row) return JSON.parse(row.value) as string;
  const id = crypto.randomUUID();
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").run(KEY, JSON.stringify(id));
  return loadInstanceId(db);
}
