import type { Database } from "bun:sqlite";
import { eventBoxes, getEvent } from "../events/store.ts";
import { contentDisposition, isTimeZone } from "./filename.ts";
import type { ExportDto } from "../api-types.ts";
import { ExportError, type Exports } from "./manager.ts";
import { parseRange } from "../recording/routes.ts";
import { HttpError } from "../http/errors.ts";
import { msg } from "../messages/index.ts";
import { json, noContent } from "../http/respond.ts";
import { asObject, bool, optStr, parseIdParam, readJson, str } from "../http/validate.ts";
import { EVENT_BUFFER_MS, type CameraId, type Route } from "../types.ts";

const STATUS = { "not-found": 404, invalid: 400, empty: 422, busy: 429, disk: 507 } as const;

function timeMs(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new HttpError(400, msg("export.timeRange", { key }));
  }
  return v;
}

function readTz(body: Record<string, unknown>): string {
  const tz = optStr(body, "tz", { max: 64 }) ?? "UTC";
  if (!isTimeZone(tz)) throw new HttpError(400, msg("export.badTimeZone"));
  return tz;
}

async function created(job: Promise<ExportDto>): Promise<Response> {
  try {
    return json(await job, 201);
  } catch (e) {
    if (e instanceof ExportError) throw new HttpError(STATUS[e.kind], e.msg);
    throw e;
  }
}

export function exportRoutes(exports: Exports, db: Database): Route[] {
  const find = (id: string | undefined) => {
    const dto = exports.get(id ?? "");
    if (!dto) throw new HttpError(404, msg("export.notFound"));
    return dto;
  };
  return [
    {
      method: "POST",
      path: "/api/exports",
      access: "user",
      async handler({ req }) {
        const body = asObject(await readJson(req));
        const tz = readTz(body);
        const cameraId = str(body, "cameraId", { max: 64 }) as CameraId;
        const startMs = timeMs(body, "startMs");
        const endMs = timeMs(body, "endMs");
        return created(exports.create({ cameraId, startMs, endMs, tz }));
      },
    },
    {
      // The event with the fixed buffer either side; one still running is cut at now.
      method: "POST",
      path: "/api/events/:id/clip",
      access: "user",
      async handler({ req, params }) {
        const id = parseIdParam(params.id);
        const event = id === null ? null : getEvent(db, id);
        if (!event) throw new HttpError(404, msg("events.notFound"));
        const body = asObject(await readJson(req));
        const tz = readTz(body);
        const boxes = body.boxes !== undefined && bool(body, "boxes") ? eventBoxes(db, event.id) : [];
        const startMs = Math.max(0, event.startMs - EVENT_BUFFER_MS);
        const endMs = event.endMs === null ? Number.MAX_SAFE_INTEGER : event.endMs + EVENT_BUFFER_MS;
        return created(exports.create({ cameraId: event.cameraId, startMs, endMs, tz }, { boxes }));
      },
    },
    { method: "GET", path: "/api/exports", access: "user", handler: () => json(exports.list()) },
    { method: "GET", path: "/api/exports/:id", access: "user", handler: ({ params }) => json(find(params.id)) },
    {
      method: "GET",
      path: "/api/exports/:id/file",
      access: "user",
      handler({ req, params }) {
        const dto = find(params.id);
        const file = exports.file(dto.id);
        if (!file) throw new HttpError(409, msg("export.notReady"));
        const headers = new Headers({
          "Content-Type": "video/mp4",
          "Content-Disposition": contentDisposition(file.fileName),
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, no-store",
        });
        const range = parseRange(req.headers.get("range"), file.sizeBytes);
        const body = Bun.file(file.path);
        if (range === "unsatisfiable") {
          headers.set("Content-Range", `bytes */${file.sizeBytes}`);
          return new Response(null, { status: 416, headers });
        }
        if (range === null) {
          headers.set("Content-Length", String(file.sizeBytes));
          return new Response(body, { headers });
        }
        headers.set("Content-Range", `bytes ${range.start}-${range.end}/${file.sizeBytes}`);
        headers.set("Content-Length", String(range.end - range.start + 1));
        return new Response(body.slice(range.start, range.end + 1), { status: 206, headers });
      },
    },
    {
      method: "DELETE",
      path: "/api/exports/:id",
      access: "user",
      handler({ params }) {
        exports.remove(find(params.id).id);
        return noContent();
      },
    },
  ];
}
