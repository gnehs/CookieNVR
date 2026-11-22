import { extname } from "node:path";
import { chunksOf } from "../detect/protocol.ts";
import { HttpError } from "../http/errors.ts";
import { json, noContent } from "../http/respond.ts";
import { asObject, parseIdParam, readJson } from "../http/validate.ts";
import { msg } from "../messages/index.ts";
import type { CameraId, Route } from "../types.ts";
import { parseClassName, parseFrigateConfig } from "./config.ts";
import { StateError, type StateClassification, type StateSensor } from "./service.ts";

const STATUS = { invalid: 400, busy: 409 } as const;
/** Bun.serve 預設的請求本體上限是 128 MB */
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const IMMUTABLE = "private, max-age=86400, immutable";

function idList(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 1000 || !v.every((x) => typeof x === "string" && /^[0-9a-f]{1,32}$/.test(x))) {
    throw new HttpError(400, msg("states.idsInvalid"));
  }
  return v as string[];
}

async function saveUpload(req: Request, path: string): Promise<void> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_IMPORT_BYTES) throw new HttpError(413, msg("states.fileTooLarge"));
  if (!req.body) throw new HttpError(400, msg("states.noFile"));
  const sink = Bun.file(path).writer();
  let size = 0;
  try {
    for await (const chunk of chunksOf(req.body)) {
      size += chunk.length;
      if (size > MAX_IMPORT_BYTES) throw new HttpError(413, msg("states.fileTooLarge"));
      sink.write(chunk);
    }
  } finally {
    await sink.end();
  }
  if (size < 22) throw new HttpError(400, msg("states.notZip"));
  const head = new Uint8Array(await Bun.file(path).slice(0, 4).arrayBuffer());
  if (head[0] !== 0x50 || head[1] !== 0x4b) throw new HttpError(400, msg("states.notZip"));
}

function withStatus(route: Route): Route {
  return {
    ...route,
    async handler(ctx) {
      try {
        return await route.handler(ctx);
      } catch (e) {
        throw e instanceof StateError ? new HttpError(STATUS[e.kind], e.msg) : e;
      }
    },
  };
}

export function stateRoutes(states: StateClassification): Route[] {
  const sensorOf = (id: string | undefined): StateSensor => {
    const s = states.sensor(id ?? "");
    if (!s) throw new HttpError(404, msg("states.sensorNotFound"));
    return s;
  };
  const routes: Route[] = [
    {
      method: "GET",
      path: "/api/states",
      access: "user",
      handler: ({ url }) => {
        const cameraId = url.searchParams.get("cameraId");
        return json(states.list().filter((s) => !cameraId || s.cameraId === cameraId));
      },
    },
    {
      method: "POST",
      path: "/api/states",
      access: "admin",
      async handler({ req }) {
        const body = asObject(await readJson(req));
        if (typeof body.cameraId !== "string") throw new HttpError(400, msg("states.cameraNotFound"));
        return json(states.create(body.cameraId as CameraId, body.config, body.collect !== false), 201);
      },
    },
    {
      method: "POST",
      path: "/api/states/frigate-config",
      access: "admin",
      async handler({ req }) {
        const body = asObject(await readJson(req));
        if (typeof body.yaml !== "string" || body.yaml.length > 200_000) throw new HttpError(400, msg("states.yamlNotString"));
        return json(parseFrigateConfig(body.yaml));
      },
    },
    { method: "GET", path: "/api/states/:id", access: "user", handler: ({ params }) => json(sensorOf(params.id).dto()) },
    {
      method: "PUT",
      path: "/api/states/:id",
      access: "admin",
      async handler({ req, params }) {
        const s = sensorOf(params.id);
        const body = asObject(await readJson(req));
        return json(s.update(body.config));
      },
    },
    {
      method: "DELETE",
      path: "/api/states/:id",
      access: "admin",
      async handler({ params }) {
        await sensorOf(params.id).remove();
        return noContent();
      },
    },
    {
      method: "POST",
      path: "/api/states/:id/classes/rename",
      access: "admin",
      async handler({ req, params }) {
        const s = sensorOf(params.id);
        const body = asObject(await readJson(req));
        return json(s.renameClass(parseClassName(body.from), parseClassName(body.to, true)));
      },
    },
    { method: "POST", path: "/api/states/:id/collect", access: "admin", handler: ({ params }) => json(sensorOf(params.id).collect(), 202) },
    { method: "POST", path: "/api/states/:id/train", access: "admin", handler: ({ params }) => json(sensorOf(params.id).train(), 202) },
    {
      method: "POST",
      path: "/api/states/:id/import",
      access: "admin",
      accepts: ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
      async handler({ req, params }) {
        return json(await sensorOf(params.id).importZip((path) => saveUpload(req, path)), 202);
      },
    },
    {
      method: "GET",
      path: "/api/states/:id/images",
      access: "user",
      handler({ params, url }) {
        const s = sensorOf(params.id);
        return json({ images: s.images(url.searchParams.get("label") ?? "all") });
      },
    },
    {
      method: "GET",
      path: "/api/states/:id/images/:imageId",
      access: "user",
      handler({ params }) {
        const path = sensorOf(params.id).imagePath(params.imageId ?? "");
        if (!path) throw new HttpError(404, msg("states.imageNotFound"));
        return new Response(Bun.file(path), { headers: { "Content-Type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream", "Cache-Control": IMMUTABLE } });
      },
    },
    {
      method: "POST",
      path: "/api/states/:id/images/label",
      access: "admin",
      async handler({ req, params }) {
        const s = sensorOf(params.id);
        const body = asObject(await readJson(req));
        const ids = idList(body.ids);
        return json(s.setLabels(ids, body.label === null ? null : parseClassName(body.label)));
      },
    },
    {
      method: "POST",
      path: "/api/states/:id/images/delete",
      access: "admin",
      async handler({ req, params }) {
        const s = sensorOf(params.id);
        const body = asObject(await readJson(req));
        return json(s.deleteImages(idList(body.ids)));
      },
    },
    {
      method: "GET",
      path: "/api/state-changes",
      access: "user",
      handler({ url }) {
        const q = url.searchParams;
        return json(
          states.changes({
            sensorId: q.get("sensorId"),
            cameraId: q.get("cameraId"),
            before: parseIdParam(q.get("before") ?? undefined),
            limit: Math.min(500, Math.max(1, Number(q.get("limit") ?? 50) || 50)),
          }),
        );
      },
    },
    {
      method: "GET",
      path: "/api/state-changes/:id/thumb.jpg",
      access: "user",
      async handler({ params }) {
        const id = parseIdParam(params.id);
        const path = id === null ? null : states.changeThumb(id);
        const file = path ? Bun.file(path) : null;
        if (!file || !(await file.exists())) throw new HttpError(404, msg("states.noThumb"));
        return new Response(file, { headers: { "Content-Type": "image/jpeg", "Cache-Control": IMMUTABLE } });
      },
    },
  ];
  return routes.map(withStatus);
}
