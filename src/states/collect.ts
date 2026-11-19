/** 從錄影抽樣的時間點：所有已完成的片段接成一條時間軸，平均取 n 點，每點落在哪個片段的第幾秒 */
export function samplePoints(segments: { path: string; startMs: number; endMs: number | null }[], n: number): { path: string; offset: number; at: number }[] {
  const usable = segments.filter((s): s is typeof s & { endMs: number } => s.endMs !== null && s.endMs - s.startMs >= 2_000);
  const total = usable.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
  if (total === 0 || n <= 0) return [];
  const points: { path: string; offset: number; at: number }[] = [];
  let seg = 0;
  let before = 0;
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) * total) / n;
    while (seg < usable.length - 1 && t >= before + (usable[seg]!.endMs - usable[seg]!.startMs)) {
      before += usable[seg]!.endMs - usable[seg]!.startMs;
      seg++;
    }
    const s = usable[seg]!;
    const offsetMs = Math.min(t - before, s.endMs - s.startMs - 1_000);
    points.push({ path: s.path, offset: Math.round(offsetMs) / 1000, at: s.startMs + Math.round(offsetMs) });
  }
  return points;
}
