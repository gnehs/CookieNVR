import type { CameraDto, ProbeResult } from "../api-types.ts";
import type { Camera, CameraConfig, CameraConnection, CameraId, CameraStore, Route } from "../types.ts";
import { HttpError } from "./errors.ts";
import { parseCameraConfig, parseConnection } from "./parse.ts";
import { json, noContent } from "./respond.ts";
import { readJson } from "./validate.ts";

export interface CameraDeps {
  cameras: CameraStore;
  probe: (conn: CameraConnection) => Promise<ProbeResult>;
  cameraStatus: (id: CameraId) => { online: boolean; recording: boolean };
  rtspUrls: (id: CameraId, req: Request) => { main: string; sub: string | null };
}

const stripUrlCredentials = (url: string) => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1");

/** 一般使用者看不到相機的帳號、密碼，也看不到嵌在 RTSP 網址裡的帳密。 */
export function redactConfig(config: CameraConfig): CameraConfig {
  const c = config.connection;
  let connection: CameraConnection;
  if (c.type === "tapo") {
    connection = { ...c, username: "", password: "" };
  } else {
    connection = { ...c, mainUrl: stripUrlCredentials(c.mainUrl) };
    if (c.subUrl !== undefined) connection.subUrl = stripUrlCredentials(c.subUrl);
    if (c.onvif) connection.onvif = { ...c.onvif, username: "", password: "" };
  }
  return { ...config, connection };
}

export function cameraRoutes({ cameras, probe, cameraStatus, rtspUrls }: CameraDeps): Route[] {
  const toDto = (camera: Camera, req: Request, admin: boolean): CameraDto => ({
    id: camera.id,
    position: camera.position,
    config: admin ? camera.config : redactConfig(camera.config),
    ...cameraStatus(camera.id),
    rtsp: rtspUrls(camera.id, req),
  });

  const find = (raw: string | undefined): Camera => {
    const camera = cameras.get((raw ?? "") as CameraId);
    if (!camera) throw new HttpError(404, "找不到攝影機");
    return camera;
  };

  return [
    {
      method: "GET",
      path: "/api/cameras",
      access: "user",
      handler(ctx) {
        const admin = ctx.principal?.role === "admin";
        return json(cameras.list().map((c) => toDto(c, ctx.req, admin)));
      },
    },
    {
      method: "POST",
      path: "/api/cameras",
      access: "admin",
      async handler(ctx) {
        const camera = cameras.create(parseCameraConfig(await readJson(ctx.req)));
        return json(toDto(camera, ctx.req, true), 201);
      },
    },
    {
      method: "POST",
      path: "/api/cameras/test",
      access: "admin",
      async handler(ctx) {
        return json(await probe(parseConnection(await readJson(ctx.req))));
      },
    },
    {
      method: "PUT",
      path: "/api/cameras/:id",
      access: "admin",
      async handler(ctx) {
        const existing = find(ctx.params.id);
        const config = parseCameraConfig(await readJson(ctx.req));
        return json(toDto(cameras.update(existing.id, config), ctx.req, true));
      },
    },
    {
      method: "DELETE",
      path: "/api/cameras/:id",
      access: "admin",
      handler(ctx) {
        cameras.remove(find(ctx.params.id).id);
        return noContent();
      },
    },
  ];
}
