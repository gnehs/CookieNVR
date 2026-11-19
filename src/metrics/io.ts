import { readdir, readFile, readlink, realpath, stat } from "node:fs/promises";

export type RunResult = { missing: true } | { missing: false; code: number | null; stdout: string; stderr: string; timedOut: boolean };

/** Everything the metrics module reads from the system; tests pass a fake built from sample files. */
export interface MetricsIo {
  platform: NodeJS.Platform;
  /** null when the file is missing or unreadable */
  readText(path: string): Promise<string | null>;
  readDir(path: string): Promise<string[] | null>;
  readLink(path: string): Promise<string | null>;
  realPath(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  /** `missing` when the command is not on PATH */
  run(cmd: string[], timeoutMs: number): Promise<RunResult>;
}

const orNull = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};

export const systemIo: MetricsIo = {
  platform: process.platform,
  readText: (path) => orNull(readFile(path, "utf8")),
  readDir: (path) => orNull(readdir(path)),
  readLink: (path) => orNull(readlink(path)),
  realPath: (path) => orNull(realpath(path)),
  exists: async (path) => (await orNull(stat(path))) !== null,
  async run(cmd, timeoutMs) {
    const bin = Bun.which(cmd[0]!);
    if (!bin) return { missing: true };
    const proc = Bun.spawn([bin, ...cmd.slice(1)], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return { missing: false, code: timedOut ? null : code, stdout, stderr, timedOut };
  },
};
