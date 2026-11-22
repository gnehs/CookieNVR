import type { Database } from "bun:sqlite";
import { msg } from "../messages/index.ts";
import { HttpError } from "../http/errors.ts";
import type { CameraId, Route } from "../types.ts";
import { thumbPath } from "./paths.ts";
import { eventsBefore, getEvent, queryEvents } from "./store.ts";
import type { EventTracker } from "./tracker.ts";

export { thumbPath };

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

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
        if (start === "invalid" || end === "invalid") throw new HttpError(400, msg("http.badRange"));
        if (limit === "invalid" || (limit !== null && limit < 1)) throw new HttpError(400, msg("events.badLimit"));
        const before = parseInteger(q.get("before"));
        if (before === "invalid") throw new HttpError(400, msg("events.badBefore"));
        const camera = q.get("camera");
        const cameraId = camera ? (camera as CameraId) : null;
        const max = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);
        // label=person,car：含任一類別
        const labels = (q.get("label") ?? "").split(",").map((l) => l.trim()).filter((l) => l !== "" && l.length <= 40).slice(0, 20);
        const filter = labels.length ? labels : null;
        if (before !== null) return Response.json(eventsBefore(db, { cameraId, labels: filter, before, limit: max }));
        const startMs = start ?? 0;
        const endMs = end ?? Number.MAX_SAFE_INTEGER;
        if (endMs < startMs) throw new HttpError(400, msg("http.endBeforeStart"));
        return Response.json(queryEvents(db, { cameraId, labels: filter, startMs, endMs, limit: max }));
      },
    },
    {
      method: "GET",
      path: "/api/events/:id",
      access: "user",
      handler({ params }) {
        const event = eventOf(db, params.id);
        if (!event) throw new HttpError(404, msg("events.notFound"));
        return Response.json(event);
      },
    },
    {
      method: "DELETE",
      path: "/api/events/:id",
      access: "admin",
      async handler({ params }) {
        const event = eventOf(db, params.id);
        if (!event) throw new HttpError(404, msg("events.notFound"));
        const result = await deps.events.remove(event.id);
        if (result === "active") throw new HttpError(409, msg("events.active"));
        if (result === "missing") throw new HttpError(404, msg("events.notFound"));
        return new Response(null, { status: 204 });
      },
    },
    {
      method: "GET",
      path: "/api/events/:id/thumb.jpg",
      access: "user",
      async handler({ params }) {
        const event = eventOf(db, params.id);
        if (!event) throw new HttpError(404, msg("events.notFound"));
        const file = Bun.file(thumbPath(dataDir, event.id));
        if (!(await file.exists())) throw new HttpError(404, msg("events.thumbnailMissing"));
        // An event in progress replaces its thumbnail whenever the score peaks.
        const cache = event.endMs === null ? "no-store" : "private, max-age=86400";
        return new Response(file, { headers: { "Content-Type": "image/jpeg", "Cache-Control": cache } });
      },
    },
  ];
}
