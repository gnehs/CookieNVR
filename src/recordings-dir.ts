import { statSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "./env.ts";

export const MOUNTED_RECORDINGS_DIR = "/recordings";

/** 路徑存在，而且和根目錄不在同一個檔案系統上，代表它是另外掛進來的 */
export function isSeparateMount(path: string, stat: (p: string) => { dev: number } = statSync): boolean {
  try {
    return stat(path).dev !== stat("/").dev;
  } catch {
    return false;
  }
}

/**
 * 錄影的預設位置：
 * 1. 有設 RECORDINGS_DIR 就用它。
 * 2. 容器掛了 /recordings 就用它，讓資料庫與錄影可以放在不同的碟。
 * 3. 否則放在資料目錄底下。
 * 只掛 /data 的人不會把錄影寫進容器自己的檔案系統（重建容器就會消失）。
 */
export function defaultRecordingsDir(env: Env, mounted: (path: string) => boolean = isSeparateMount): string {
  if (env.recordingsDir) return env.recordingsDir;
  if (mounted(MOUNTED_RECORDINGS_DIR)) return MOUNTED_RECORDINGS_DIR;
  return join(env.dataDir, "recordings");
}
