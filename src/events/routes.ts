import type { Database } from "bun:sqlite";
import type { ErrorDto } from "../api-types.ts";
import type { CameraId, Route } from "../types.ts";
import { thumbPath } from "./paths.ts";
import { eventsBefore, getEvent, queryEvents } from "./store.ts";
import type { EventTracker } from "./tracker.ts";

export { thumbPath };

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

const fail = (status: number, error: string) => Response.json({ error } satisfies ErrorDto, { status });

function parseInteger(value: string | null): number | null | "invalid" {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : "invalid";
}

const eventOf = (db: Database, raw: string | undefined) => {
  const id = Number(raw);
  return Number.isSafeInteger(id) ? getEvent(db, id) : null;
};

export function eventRoutes(deps: { db: Database; dataDir: string; events: Pick<EventTracker, "remove"> }): Route[] {
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
        const before = parseInteger(q.get("before"));
        if (before === "invalid") return fail(400, "before must be integer UTC milliseconds");
        const camera = q.get("camera");
        const cameraId = camera ? (camera as CameraId) : null;
        const max = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);
        if (before !== null) return Response.json(eventsBefore(db, { cameraId, before, limit: max }));
        const startMs = start ?? 0;
        const endMs = end ?? Number.MAX_SAFE_INTEGER;
        if (endMs < startMs) return fail(400, "end must not be before start");
        return Response.json(queryEvents(db, { cameraId, startMs, endMs, limit: max }));
      },
    },
    {
      method: "GET",
      path: "/api/events/:id",
      access: "user",
      handler({ params }) {
        const event = eventOf(db, params.id);
        return event ? Response.json(event) : fail(404, "找不到這筆事件");
      },
    },
    {
      method: "DELETE",
      path: "/api/events/:id",
      access: "admin",
      async handler({ params }) {
        const event = eventOf(db, params.id);
        if (!event) return fail(404, "找不到這筆事件");
        const result = await deps.events.remove(event.id);
        if (result === "active") return fail(409, "事件還在進行中，結束後才能刪除");
        if (result === "missing") return fail(404, "找不到這筆事件");
        return new Response(null, { status: 204 });
      },
    },
    {
      method: "GET",
      path: "/api/events/:id/thumb.jpg",
      access: "user",
      async handler({ params }) {
        const event = eventOf(db, params.id);
        if (!event) return fail(404, "event not found");
        const file = Bun.file(thumbPath(dataDir, event.id));
        if (!(await file.exists())) return fail(404, "thumbnail not found");
        // An event in progress replaces its thumbnail whenever the score peaks.
        const cache = event.endMs === null ? "no-store" : "private, max-age=86400";
        return new Response(file, { headers: { "Content-Type": "image/jpeg", "Cache-Control": cache } });
      },
    },
  ];
}
