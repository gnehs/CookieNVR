/**
 * Pure planning of an export: which segments a range touches and how much of each to keep.
 * Imported by the browser too (for the size estimate before the user starts), so it must stay free of node APIs.
 */

export const MAX_EXPORT_MS = 2 * 60 * 60_000;
export const MIN_EXPORT_MS = 1_000;

export interface PlanSegment {
  id: number;
  startMs: number;
  /** null = still recording */
  endMs: number | null;
  size: number;
}

export interface PlanPart {
  segmentId: number;
  /** The segment is still being written; the exporter takes what is on disk now. */
  open: boolean;
  /** Seek into the file before the first kept packet; the actual cut snaps back to a keyframe. */
  inpointMs: number;
  /** Stop here; null = keep through the end of the file. */
  outpointMs: number | null;
  coveredMs: number;
  bytes: number;
}

export type ExportPlan =
  | {
      ok: true;
      parts: PlanPart[];
      /** The range actually exported: the request, with an end in the future pulled back to now. */
      startMs: number;
      endMs: number;
      /** Recorded time inside the range; gaps are skipped, so it can be shorter than end - start. */
      durationMs: number;
      estimatedBytes: number;
      includesRecording: boolean;
    }
  | { ok: false; reason: "invalid" | "too-long" | "empty"; message: string };

export function planExport(segments: readonly PlanSegment[], startMs: number, endMs: number, now: number): ExportPlan {
  const end = Math.min(endMs, now);
  if (!(end - startMs >= MIN_EXPORT_MS)) {
    return { ok: false, reason: "invalid", message: "選取的範圍太短，至少要 1 秒" };
  }
  if (end - startMs > MAX_EXPORT_MS) {
    return { ok: false, reason: "too-long", message: "一次最多匯出 2 小時，請縮短選取的範圍" };
  }
  const parts: PlanPart[] = [];
  const sorted = segments.slice().sort((a, b) => a.startMs - b.startMs);
  for (const s of sorted) {
    const segEnd = s.endMs ?? Math.max(now, s.startMs);
    const lo = Math.max(startMs, s.startMs);
    const hi = Math.min(end, segEnd);
    if (hi <= lo) continue;
    const span = Math.max(1, segEnd - s.startMs);
    parts.push({
      segmentId: s.id,
      open: s.endMs === null,
      inpointMs: lo - s.startMs,
      outpointMs: hi < segEnd ? hi - s.startMs : null,
      coveredMs: hi - lo,
      bytes: Math.round((s.size * (hi - lo)) / span),
    });
  }
  if (parts.length === 0) return { ok: false, reason: "empty", message: "這段時間沒有錄影" };
  return {
    ok: true,
    parts,
    startMs,
    endMs: end,
    durationMs: parts.reduce((n, p) => n + p.coveredMs, 0),
    estimatedBytes: parts.reduce((n, p) => n + p.bytes, 0),
    includesRecording: parts.some((p) => p.open),
  };
}
