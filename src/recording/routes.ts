import type { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import type { ErrorDto, SegmentDto } from "../api-types.ts";
import type { CameraId, Route, Segment } from "../types.ts";
import { getSegment, quarterHourBuckets, segmentsInRange } from "./store.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error } satisfies ErrorDto, status);

const toDto = (s: Segment): SegmentDto => ({
  id: s.id,
  cameraId: s.cameraId,
  startMs: s.startMs,
  endMs: s.endMs,
  size: s.size,
});

function parseMs(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function dayFormatter(tz: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return null;
  }
}

export type ByteRange = { start: number; end: number };

/**
 * Parses a single-range `Range` header against the current size.
 * null = ignore the header and send the whole file; "unsatisfiable" = 416.
 */
export function parseRange(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
  if (header === null) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a = "", b = ""] = m;
  if (a === "" && b === "") return null;
  if (a === "") {
    const suffix = Number(b);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(a);
  if (start >= size) return "unsatisfiable";
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return null;
  return { start, end };
}

export function recordingRoutes(deps: { db: Database }): Route[] {
  const { db } = deps;
  return [
    {
      method: "GET",
      path: "/api/cameras/:id/days",
      access: "user",
      handler({ url, params }) {
        const tz = url.searchParams.get("tz") ?? "UTC";
        const fmt = dayFormatter(tz);
        if (!fmt) return fail(400, `invalid tz: ${tz}`);
        // Every IANA offset is a multiple of 15 minutes, so a quarter-hour bucket never straddles a local midnight.
        const days = new Set(quarterHourBuckets(db, params.id as CameraId).map((ms) => fmt.format(ms)));
        return json([...days].sort());
      },
    },
    {
      method: "GET",
      path: "/api/cameras/:id/recordings",
      access: "user",
      handler({ url, params }) {
        const start = parseMs(url.searchParams.get("start"));
        const end = parseMs(url.searchParams.get("end"));
        if (start === null || end === null) return fail(400, "start and end must be integer UTC milliseconds");
        if (end < start) return fail(400, "end must not be before start");
        return json(segmentsInRange(db, params.id as CameraId, start, end).map(toDto));
      },
    },
    {
      method: "GET",
      path: "/api/segments/:id",
      access: "user",
      async handler({ req, params }) {
        const id = Number(params.id);
        const segment = Number.isSafeInteger(id) ? getSegment(db, id) : null;
        if (!segment) return fail(404, "segment not found");
        // A recording segment keeps growing, so the size is read per request rather than from the index.
        const size = await stat(segment.path).then((s) => s.size, () => null);
        if (size === null) return fail(404, "segment file missing");

        const headers = new Headers({
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
          "Cache-Control": segment.endMs === null ? "no-store" : "private, max-age=86400",
        });
        const file = Bun.file(segment.path);
        const range = parseRange(req.headers.get("range"), size);
        if (range === "unsatisfiable") {
          headers.set("Content-Range", `bytes */${size}`);
          return new Response(null, { status: 416, headers });
        }
        if (range === null) {
          headers.set("Content-Length", String(size));
          return new Response(file.slice(0, size), { status: 200, headers });
        }
        headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
        headers.set("Content-Length", String(range.end - range.start + 1));
        return new Response(file.slice(range.start, range.end + 1), { status: 206, headers });
      },
    },
  ];
}
