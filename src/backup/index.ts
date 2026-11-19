import type { Database } from "bun:sqlite";
import { Database as SqliteDatabase } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

export const BACKUP_KEEP = 7;

const NAME = /^cookienvr-(\d{4})(\d{2})(\d{2})\.db$/;

export interface BackupDeps {
  db: Database;
  /** `<dataDir>/backup` */
  dir: string;
  keep?: number;
}

export interface BackupResult {
  /** null = today's backup already existed */
  created: string | null;
  pruned: string[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** One file per local calendar day, named so that a plain sort is chronological. */
export function backupName(ms: number): string {
  const d = new Date(ms);
  return `cookienvr-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.db`;
}

export function listBackups(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => NAME.test(n))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Copying the database file is unsafe in WAL mode (the newest pages live in the -wal file), so the
 * snapshot is taken by SQLite itself with VACUUM INTO, which reads one consistent view while writers carry on.
 * It lands under a temporary name and is only renamed into place once it opens and passes a check.
 */
export function backupOnce(deps: BackupDeps, now: number): BackupResult {
  const keep = deps.keep ?? BACKUP_KEEP;
  mkdirSync(deps.dir, { recursive: true });
  const name = backupName(now);
  const target = join(deps.dir, name);
  let created: string | null = null;
  if (!existsSync(target)) {
    const tmp = join(deps.dir, `${name}.tmp`);
    rmSync(tmp, { force: true });
    try {
      deps.db.query("VACUUM INTO ?").run(tmp);
      const copy = new SqliteDatabase(tmp, { readonly: true });
      try {
        const row = copy.query("PRAGMA quick_check").get() as { quick_check: string };
        if (row.quick_check !== "ok") throw new Error(`backup failed integrity check: ${row.quick_check}`);
      } finally {
        copy.close();
      }
      renameSync(tmp, target);
      created = target;
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }
  const all = listBackups(deps.dir);
  const pruned = all.slice(0, Math.max(0, all.length - keep));
  for (const n of pruned) rmSync(join(deps.dir, n), { force: true });
  return { created, pruned };
}
