import { contentDisposition, isTimeZone } from "./filename.ts";
import { ExportError, type Exports } from "./manager.ts";
import { parseRange } from "../recording/routes.ts";
import { HttpError } from "../http/errors.ts";
import { msg } from "../messages/index.ts";
import { json, noContent } from "../http/respond.ts";
import { asObject, optStr, readJson, str } from "../http/validate.ts";
import type { CameraId, Route } from "../types.ts";

const STATUS = { "not-found": 404, invalid: 400, empty: 422, busy: 429, disk: 507 } as const;

function timeMs(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new HttpError(400, msg("export.timeRange", { key }));
  }
  return v;
}

export function exportRoutes(exports: Exports): Route[] {
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
        const tz = optStr(body, "tz", { max: 64 }) ?? "UTC";
        if (!isTimeZone(tz)) throw new HttpError(400, msg("export.badTimeZone"));
        try {
          const dto = await exports.create({
            cameraId: str(body, "cameraId", { max: 64 }) as CameraId,
            startMs: timeMs(body, "startMs"),
            endMs: timeMs(body, "endMs"),
            tz,
          });
          return json(dto, 201);
        } catch (e) {
          if (e instanceof ExportError) throw new HttpError(STATUS[e.kind], e.msg);
          throw e;
        }
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
