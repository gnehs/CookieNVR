import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.ts";
import { backupName, backupOnce, listBackups } from "./index.ts";

const dirs: string[] = [];
const open: Database[] = [];
afterEach(() => {
  for (const d of open.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "cookienvr-bak-"));
  dirs.push(root);
  const db = openDb(join(root, "cookienvr.db"));
  open.push(db);
  return { root, db, dir: join(root, "backup") };
}

const day = (n: number) => new Date(2026, 10, n, 12, 0, 0).getTime();

describe("daily backup", () => {
  test("a WAL-mode database with unflushed writes is captured completely and opens on its own", () => {
    const { root, db, dir } = setup();
    db.run("PRAGMA wal_autocheckpoint = 0");
    for (let i = 0; i < 200; i++) db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(`k${i}`, JSON.stringify({ i }));
    db.query("INSERT INTO users (username, password_hash, role, created_at) VALUES ('amy', 'h', 'admin', 1)").run();
    expect(statSync(join(root, "cookienvr.db-wal")).size).toBeGreaterThan(0);

    const { created } = backupOnce({ db, dir }, day(10));
    expect(created).toBe(join(dir, "cookienvr-20261110.db"));

    // Opened alone, without the -wal file the original still has
    const copy = new Database(created!, { readonly: true });
    open.push(copy);
    expect((copy.query("SELECT count(*) AS n FROM settings").get() as { n: number }).n).toBe(200);
    expect((copy.query("SELECT username FROM users").get() as { username: string }).username).toBe("amy");
    expect((copy.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBeGreaterThan(0);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("runs once per day: a second call the same day keeps the first snapshot", () => {
    const { db, dir } = setup();
    expect(backupOnce({ db, dir }, day(10)).created).not.toBeNull();
    db.query("INSERT INTO settings (key, value) VALUES ('late', '1')").run();
    expect(backupOnce({ db, dir }, day(10)).created).toBeNull();
    expect(listBackups(dir)).toEqual(["cookienvr-20261110.db"]);
  });

  test("keeps the newest seven and removes older ones", () => {
    const { db, dir } = setup();
    for (let d = 1; d <= 10; d++) backupOnce({ db, dir }, day(d));
    expect(listBackups(dir)).toEqual([4, 5, 6, 7, 8, 9, 10].map((d) => backupName(day(d))));
  });

  test("unrelated files in the backup directory are never touched", () => {
    const { db, dir } = setup();
    backupOnce({ db, dir }, day(1));
    Bun.write(join(dir, "notes.txt"), "keep me");
    for (let d = 2; d <= 12; d++) backupOnce({ db, dir }, day(d));
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });
});
