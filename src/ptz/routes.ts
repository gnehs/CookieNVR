import type { PtzDto, PtzMoveResultDto, PtzPresetSavedDto, PtzPresetsDto } from "../api-types.ts";
import { json, noContent } from "../http/respond.ts";
import { readJson } from "../http/validate.ts";
import type { CameraId, Route } from "../types.ts";
import type { PtzHub } from "./hub.ts";
import { parsePtzCommand, parseRemovePreset, parseSavePreset } from "./parse.ts";

export interface PtzRouteDeps {
  hub: PtzHub;
}

export function ptzRoutes({ hub }: PtzRouteDeps): Route[] {
  const id = (raw: string | undefined) => (raw ?? "") as CameraId;

  return [
    {
      method: "GET",
      path: "/api/cameras/:id/ptz",
      access: "user",
      async handler(ctx) {
        const info = await hub.info(id(ctx.params.id));
        if (!info.supported) return json({ supported: false, reason: info.reason } satisfies PtzDto);
        return json({ supported: true, ...info.caps, presets: info.presets, prefs: info.prefs } satisfies PtzDto);
      },
    },
    {
      method: "POST",
      path: "/api/cameras/:id/ptz",
      access: "user",
      async handler(ctx) {
        const cmd = parsePtzCommand(await readJson(ctx.req));
        const cameraId = id(ctx.params.id);
        switch (cmd.action) {
          case "move":
            return json({ mode: await hub.move(cameraId, cmd) } satisfies PtzMoveResultDto);
          case "stop":
            await hub.stop(cameraId);
            return noContent();
          case "preset":
            await hub.gotoPreset(cameraId, cmd.token, cmd.speed);
            return noContent();
        }
      },
    },
    {
      method: "POST",
      path: "/api/cameras/:id/ptz/presets",
      access: "admin",
      async handler(ctx) {
        const { name, token } = parseSavePreset(await readJson(ctx.req));
        const saved = await hub.savePreset(id(ctx.params.id), name, token);
        return json(saved satisfies PtzPresetSavedDto, token === undefined ? 201 : 200);
      },
    },
    {
      method: "DELETE",
      path: "/api/cameras/:id/ptz/presets",
      access: "admin",
      async handler(ctx) {
        const { token } = parseRemovePreset(await readJson(ctx.req));
        const presets = await hub.removePreset(id(ctx.params.id), token);
        return json({ presets } satisfies PtzPresetsDto);
      },
    },
  ];
}
