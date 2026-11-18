import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { ErrorDto } from "../api-types.ts";
import type { CameraId, Route } from "../types.ts";
import { getEvent, queryEvents } from "./store.ts";

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

const fail = (status: number, error: string) => Response.json({ error } satisfies ErrorDto, { status });

function parseInteger(value: string | null): number | null | "invalid" {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : "invalid";
}

export const thumbPath = (dataDir: string, id: number) => join(dataDir, "thumbs", `${id}.jpg`);

export function eventRoutes(deps: { db: Database; dataDir: string }): Route[] {
  const { db, dataDir } = deps;
  return [
    {
      method: "GET",
      path: "/api/events",
      access: "user",
      handler({ url }) {
        const q = url.searchParams;
        const start = parseInteger(q.get("start"));
        const end = parseInteger(q.get("end"));
        const limit = parseInteger(q.get("limit"));
        if (start === "invalid" || end === "invalid") return fail(400, "start and end must be integer UTC milliseconds");
        if (limit === "invalid" || (limit !== null && limit < 1)) return fail(400, "limit must be a positive integer");
        const startMs = start ?? 0;
        const endMs = end ?? Number.MAX_SAFE_INTEGER;
        if (endMs < startMs) return fail(400, "end must not be before start");
        const camera = q.get("camera");
        return Response.json(
          queryEvents(db, {
            cameraId: camera ? (camera as CameraId) : null,
            startMs,
            endMs,
            limit: Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT),
          }),
        );
      },
    },
    {
      method: "GET",
      path: "/api/events/:id/thumb.jpg",
      access: "user",
      async handler({ params }) {
        const id = Number(params.id);
        const event = Number.isSafeInteger(id) ? getEvent(db, id) : null;
        if (!event) return fail(404, "event not found");
        const file = Bun.file(thumbPath(dataDir, id));
        if (!(await file.exists())) return fail(404, "thumbnail not found");
        // An event in progress replaces its thumbnail whenever the score peaks.
        const cache = event.endMs === null ? "no-store" : "private, max-age=86400";
        return new Response(file, { headers: { "Content-Type": "image/jpeg", "Cache-Control": cache } });
      },
    },
  ];
}
