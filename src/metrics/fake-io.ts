import type { MetricsIo, RunResult } from "./io.ts";

export interface FakeSystem {
  platform: NodeJS.Platform;
  files?: Record<string, string>;
  /** symlinks and realpath targets */
  links?: Record<string, string>;
  /** command name → result; missing name = not on PATH */
  commands?: Record<string, Exclude<RunResult, { missing: true }> | ((args: string[]) => Exclude<RunResult, { missing: true }>)>;
}

export const ok = (stdout: string) => ({ missing: false as const, code: 0, stdout, stderr: "", timedOut: false });

/** An in-memory system for the probes: directories are implied by file and link paths. */
export function fakeIo(sys: FakeSystem): MetricsIo & { ran: string[] } {
  const files = sys.files ?? {};
  const links = sys.links ?? {};
  const paths = [...Object.keys(files), ...Object.keys(links)];
  const ran: string[] = [];
  return {
    ran,
    platform: sys.platform,
    readText: async (p) => files[p] ?? null,
    async readDir(p) {
      const prefix = `${p}/`;
      const names = new Set(paths.filter((x) => x.startsWith(prefix)).map((x) => x.slice(prefix.length).split("/")[0]!));
      return names.size ? [...names] : null;
    },
    readLink: async (p) => links[p] ?? null,
    realPath: async (p) => links[p] ?? (p in files || paths.some((x) => x.startsWith(`${p}/`)) ? p : null),
    exists: async (p) => p in files || p in links || paths.some((x) => x.startsWith(`${p}/`)),
    async run(cmd) {
      ran.push(cmd[0]!);
      const c = sys.commands?.[cmd[0]!];
      if (!c) return { missing: true };
      return typeof c === "function" ? c(cmd.slice(1)) : c;
    },
  };
}
