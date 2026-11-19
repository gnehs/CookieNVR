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
