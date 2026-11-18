import type { SystemDto } from "../src/api-types.ts";

const DAY = 86_400_000;

/** 依各攝影機從最早一段到現在的平均用量，推算硬碟大約能存幾天；錄不到一小時的攝影機不列入 */
export function estimateDays(sys: Pick<SystemDto, "usage" | "disk">, minFreeBytes: number, now = Date.now()): number | null {
  let perDay = 0;
  for (const u of sys.usage) {
    if (u.oldestMs === null) continue;
    const span = now - u.oldestMs;
    if (span < DAY / 24) continue;
    perDay += u.bytes / (span / DAY);
  }
  if (perDay <= 0) return null;
  const recorded = sys.usage.reduce((a, u) => a + u.bytes, 0);
  return Math.max(0, (recorded + sys.disk.freeBytes - minFreeBytes) / perDay);
}
