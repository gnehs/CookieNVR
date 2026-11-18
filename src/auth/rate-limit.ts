const THRESHOLD = 5;
const BASE_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;
const PRUNE_ABOVE = 10_000;

interface Entry {
  fails: number;
  lockedUntil: number;
  lastFailAt: number;
}

/** 以 IP＋帳號為鍵，連續失敗滿 5 次後鎖定，之後每多失敗一次鎖定時間加倍（上限 15 分鐘）。 */
export function createLoginLimiter(now: () => number) {
  const entries = new Map<string, Entry>();

  function prune(t: number) {
    for (const [key, e] of entries) {
      if (e.lockedUntil <= t && t - e.lastFailAt >= MAX_LOCK_MS) entries.delete(key);
    }
  }

  return {
    retryAfterMs(key: string): number {
      const e = entries.get(key);
      if (!e) return 0;
      return Math.max(0, e.lockedUntil - now());
    },
    recordFailure(key: string): void {
      const t = now();
      let e = entries.get(key);
      // 久未失敗就重新計數，否則偶發的打錯密碼會永遠累積
      if (e && e.lockedUntil <= t && t - e.lastFailAt >= MAX_LOCK_MS) e = undefined;
      const fails = (e?.fails ?? 0) + 1;
      const lockMs =
        fails >= THRESHOLD ? Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (fails - THRESHOLD)) : 0;
      entries.set(key, { fails, lockedUntil: lockMs > 0 ? t + lockMs : 0, lastFailAt: t });
      if (entries.size > PRUNE_ABOVE) prune(t);
    },
    recordSuccess(key: string): void {
      entries.delete(key);
    },
  };
}
