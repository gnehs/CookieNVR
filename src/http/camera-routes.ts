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
  /** 攝影機已移除後呼叫；實際清除在背景進行，失敗由實作寫入日誌。 */
  purgeRecordings: (id: CameraId) => void;
  /** 對外的設定（例如只放生效中的物件類別）；沒給就原樣 */
  publicConfig?: (config: CameraConfig) => CameraConfig;
  /** 修改時把用戶端送來的設定與原本的合併；沒給就整份取代 */
  mergeConfig?: (incoming: CameraConfig, existing: CameraConfig) => CameraConfig;
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

export function cameraRoutes({ cameras, probe, cameraStatus, rtspUrls, purgeRecordings, publicConfig = (c) => c, mergeConfig = (c) => c }: CameraDeps): Route[] {
  const toDto = (camera: Camera, req: Request, admin: boolean): CameraDto => ({
    id: camera.id,
    position: camera.position,
    config: publicConfig(admin ? camera.config : redactConfig(camera.config)),
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
        const config = mergeConfig(parseCameraConfig(await readJson(ctx.req)), existing.config);
        return json(toDto(cameras.update(existing.id, config), ctx.req, true));
      },
    },
    {
      method: "DELETE",
      path: "/api/cameras/:id",
      access: "admin",
      handler(ctx) {
        const recordings = ctx.url.searchParams.get("recordings");
        if (recordings !== null && recordings !== "delete") throw new HttpError(400, "recordings 只接受 delete");
        const { id } = find(ctx.params.id);
        cameras.remove(id);
        if (recordings === "delete") purgeRecordings(id);
        return noContent();
      },
    },
  ];
}
