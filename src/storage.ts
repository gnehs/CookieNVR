import { statSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { resolve } from "node:path";
import type { DiskDto, SystemDto } from "./api-types.ts";
import type { RootUsage } from "./recording/store.ts";

export interface FsProbe {
  /** st_dev；路徑不存在時丟出錯誤 */
  dev(path: string): number;
  statfs(path: string): Promise<{ bsize: number; blocks: number; bavail: number }>;
}

export const nodeFsProbe: FsProbe = { dev: (p) => statSync(p).dev, statfs };

/**
 * 錄影與資料目錄各在多少空間的「同一顆」容許誤差。兩次 statfs 之間錄影還在寫，可用空間會差一點；
 * 不同檔案系統（例如 Unraid 的 shfs 和底下的快取池）回報的總容量可能有進位差。
 */
const SAME_TOTAL_SLACK = 1024 ** 2;
const SAME_FREE_SLACK = 64 * 1024 ** 2;

async function disk(path: string, probe: FsProbe): Promise<DiskDto> {
  const fs = await probe.statfs(path);
  return { path, totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize };
}

/**
 * 量錄影位置與資料目錄兩顆硬碟。st_dev 相同就是同一個檔案系統；不同但容量與可用空間都一樣，
 * 實際上也是同一顆（btrfs 子卷、Unraid 共享以快取池為主要儲存時，掛進來的兩個路徑底下是同一個池）。
 */
export async function measureDisks(recordingsPath: string, dataDir: string, probe: FsProbe = nodeFsProbe): Promise<Pick<SystemDto, "disk" | "dataDisk">> {
  const [rec, data] = await Promise.all([disk(recordingsPath, probe), disk(dataDir, probe)]);
  const sameDev = probe.dev(recordingsPath) === probe.dev(dataDir);
  const sameSpace = Math.abs(rec.totalBytes - data.totalBytes) <= SAME_TOTAL_SLACK && Math.abs(rec.freeBytes - data.freeBytes) <= SAME_FREE_SLACK;
  return { disk: rec, dataDisk: { ...data, sameAsRecordings: sameDev || sameSpace } };
}

/** 把各位置的用量分成「目前錄影位置」（容量條與可存天數用）與「其他位置」（只提一句） */
export function splitUsage(rows: RootUsage[], storagePath: string): Pick<SystemDto, "usage" | "elsewhere"> {
  const current = resolve(storagePath);
  const usage: SystemDto["usage"] = [];
  const elsewhere = new Map<string, number>();
  for (const r of rows) {
    if (resolve(r.root) === current) usage.push({ cameraId: r.cameraId, bytes: r.bytes, oldestMs: r.oldestMs });
    else elsewhere.set(r.root, (elsewhere.get(r.root) ?? 0) + r.bytes);
  }
  return { usage, elsewhere: [...elsewhere].map(([path, bytes]) => ({ path, bytes })).sort((a, b) => b.bytes - a.bytes) };
}
