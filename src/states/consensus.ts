/**
 * 狀態切換規則（沿用 Frigate state classification 的共識規則）：
 * - 信心低於門檻的讀數直接忽略，不影響候選的計數；
 * - 讀數等於目前狀態：清掉候選；
 * - 否則累計候選，同一類連續 REQUIRED 次才切換；換了類別就從 1 重新數。
 * 啟動後 current 是 null（未知），第一次通過驗證的狀態也算切換。
 */
export const REQUIRED = 3;

export interface Consensus {
  current: string | null;
  candidate: { label: string; count: number } | null;
}

export const UNKNOWN: Consensus = { current: null, candidate: null };

export type Step = { kind: "ignored" | "steady" | "verifying"; next: Consensus } | { kind: "switched"; next: Consensus; from: string | null };

export function step(c: Consensus, reading: { label: string; score: number }, threshold: number): Step {
  if (reading.score < threshold) return { kind: "ignored", next: c };
  if (reading.label === c.current) return { kind: "steady", next: { current: c.current, candidate: null } };
  const count = c.candidate?.label === reading.label ? c.candidate.count + 1 : 1;
  if (count >= REQUIRED) return { kind: "switched", next: { current: reading.label, candidate: null }, from: c.current };
  return { kind: "verifying", next: { current: c.current, candidate: { label: reading.label, count } } };
}
