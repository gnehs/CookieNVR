import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Workers are spawned with `detached: true` (setsid), so each worker leads its own
 * process group whose id equals the worker pid. Signalling `-pgid` reaches every
 * descendant that did not call setsid itself.
 */

export interface PidEntry {
  id: string;
  pid: number;
  /** Kernel start time of the process; tells a live worker apart from a reused pid. */
  startToken: string;
}

export function processStartToken(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm (field 2) may contain spaces and parens, so count fields after the last ")".
      // Field 22 (starttime) is index 19 of the remainder.
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
    } catch {
      return null;
    }
  }
  const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stderr: "ignore" });
  const out = r.stdout.toString().trim();
  return r.exitCode === 0 && out ? out : null;
}

export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: the group is already gone.
  }
}

export async function waitGroupGone(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(20);
  }
  return true;
}

export function readPidFile(path: string): PidEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is PidEntry =>
        typeof e?.id === "string" && Number.isInteger(e?.pid) && e.pid > 1 && typeof e?.startToken === "string",
    );
  } catch {
    return [];
  }
}

export function writePidFile(path: string, entries: PidEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries));
  renameSync(tmp, path);
}

/**
 * Whether a pid-file entry still names one of our process groups.
 *
 * POSIX never hands out a pid while a process group with that id exists. So a live
 * group whose leader is gone must still be ours, and a live pid with a different start
 * time means the pid was reused after our group had already emptied.
 */
function isOurGroup(entry: PidEntry): boolean {
  if (entry.pid === process.pid || entry.pid === process.ppid) return false;
  const token = processStartToken(entry.pid);
  if (token !== null) return token === entry.startToken;
  return groupAlive(entry.pid);
}

/** Terminates groups left behind by a previous main process that died without cleanup. */
export async function reapOrphans(pidFile: string, killGraceMs: number): Promise<string[]> {
  const orphans = readPidFile(pidFile).filter(isOurGroup);
  for (const o of orphans) signalGroup(o.pid, "SIGTERM");
  await Promise.all(
    orphans.map(async (o) => {
      if (await waitGroupGone(o.pid, killGraceMs)) return;
      signalGroup(o.pid, "SIGKILL");
      await waitGroupGone(o.pid, 1_000);
    }),
  );
  writePidFile(pidFile, []);
  return orphans.map((o) => o.id);
}
