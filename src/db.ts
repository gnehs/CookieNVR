import { Database } from "bun:sqlite";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE cameras (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    config TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE segments (
    id INTEGER PRIMARY KEY,
    camera_id TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER,
    size INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX segments_camera_start ON segments (camera_id, start_ms);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    camera_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('pixel', 'onvif')),
    start_ms INTEGER NOT NULL,
    end_ms INTEGER,
    score REAL NOT NULL DEFAULT 0,
    labels TEXT NOT NULL DEFAULT '[]',
    has_thumb INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX events_camera_start ON events (camera_id, start_ms);
  `,
  // 兩個來源合併成一筆事件時記為 both；SQLite 改不了 CHECK，只能重建資料表。
  // AUTOINCREMENT：刪掉的事件 id 不再重用，否則瀏覽器會拿快取的舊縮圖給新事件
  `
  CREATE TABLE events_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('pixel', 'onvif', 'both')),
    start_ms INTEGER NOT NULL,
    end_ms INTEGER,
    score REAL NOT NULL DEFAULT 0,
    labels TEXT NOT NULL DEFAULT '[]',
    has_thumb INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO events_v2 SELECT id, camera_id, source, start_ms, end_ms, score, labels, has_thumb FROM events;
  DROP TABLE events;
  ALTER TABLE events_v2 RENAME TO events;
  CREATE INDEX events_camera_start ON events (camera_id, start_ms);
  CREATE INDEX events_start ON events (start_ms);
  `,
  // 狀態辨識：感應器、訓練用的圖片（檔案在 <dataDir>/states/<感應器>/images）、狀態切換紀錄
  `
  CREATE TABLE state_sensors (
    id TEXT PRIMARY KEY,
    camera_id TEXT NOT NULL,
    config TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE state_images (
    id TEXT PRIMARY KEY,
    sensor_id TEXT NOT NULL REFERENCES state_sensors(id) ON DELETE CASCADE,
    file TEXT NOT NULL,
    label TEXT,
    source TEXT NOT NULL CHECK (source IN ('recording', 'live', 'import')),
    created_at INTEGER NOT NULL,
    guess_label TEXT,
    guess_score REAL
  );
  CREATE INDEX state_images_sensor ON state_images (sensor_id, created_at);
  CREATE TABLE state_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sensor_id TEXT NOT NULL,
    camera_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    score REAL NOT NULL,
    has_thumb INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX state_changes_sensor_at ON state_changes (sensor_id, at);
  CREATE INDEX state_changes_at ON state_changes (at);
  `,
  `
  CREATE TABLE camera_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  ALTER TABLE cameras ADD COLUMN group_id TEXT REFERENCES camera_groups (id) ON DELETE SET NULL;
  `,
];

/** 開啟資料庫並升級到最新 schema。測試可傳 ":memory:"。 */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");

  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    const migration = MIGRATIONS[version];
    if (migration === undefined) break;
    db.transaction(() => {
      db.run(migration);
      db.run(`PRAGMA user_version = ${version + 1}`);
    })();
  }
  return db;
}
