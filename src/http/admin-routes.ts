import type { SettingsDto, SystemDto } from "../api-types.ts";
import type { Auth, UserPatch } from "../auth/index.ts";
import type { Route, SettingsStore, Supervisor } from "../types.ts";
import { HttpError } from "./errors.ts";
import { parseSettingsPatch } from "./parse.ts";
import { json, noContent } from "./respond.ts";
import { asObject, oneOf, parseIdParam, readJson, str } from "./validate.ts";
import { msg } from "../messages/index.ts";

export interface AdminDeps {
  auth: Auth;
  settings: SettingsStore;
  system: () => Promise<SystemDto>;
  /** 給使用者貼給 AI 除錯的純文字報告，密碼等機密已遮蔽；camera 為 null 時涵蓋整個系統 */
  diagnostics: (camera: string | null) => Promise<string>;
  supervisor: Pick<Supervisor, "restart">;
}

function userId(raw: string | undefined): number {
  const id = parseIdParam(raw);
  if (id === null) throw new HttpError(404, msg("auth.userNotFound"));
  return id;
}

export function adminRoutes({ auth, settings, system, diagnostics, supervisor }: AdminDeps): Route[] {
  const roles = ["user", "admin"] as const;

  return [
    { method: "GET", path: "/api/users", access: "admin", handler: () => json(auth.listUsers()) },
    {
      method: "POST",
      path: "/api/users",
      access: "admin",
      async handler(ctx) {
        const body = asObject(await readJson(ctx.req));
        const user = await auth.createUser(
          str(body, "username", { max: 256 }),
          str(body, "password", { max: 1024, allowEmpty: true }),
          oneOf(body, "role", roles),
        );
        return json(user, 201);
      },
    },
    {
      method: "PUT",
      path: "/api/users/:id",
      access: "admin",
      async handler(ctx) {
        const id = userId(ctx.params.id);
        const body = asObject(await readJson(ctx.req));
        const patch: UserPatch = {};
        if (body.role !== undefined) patch.role = oneOf(body, "role", roles);
        if (body.password !== undefined) patch.password = str(body, "password", { max: 1024, allowEmpty: true });
        if (patch.role === undefined && patch.password === undefined) {
          throw new HttpError(400, msg("auth.roleOrPassword"));
        }
        return json(await auth.updateUser(id, patch));
      },
    },
    {
      method: "DELETE",
      path: "/api/users/:id",
      access: "admin",
      handler(ctx) {
        auth.removeUser(userId(ctx.params.id));
        return noContent();
      },
    },
    { method: "GET", path: "/api/settings", access: "admin", handler: () => json(settings.get() satisfies SettingsDto) },
    {
      method: "PUT",
      path: "/api/settings",
      access: "admin",
      async handler(ctx) {
        const patch = parseSettingsPatch(await readJson(ctx.req), settings.get());
        return json(settings.update(patch) satisfies SettingsDto);
      },
    },
    { method: "GET", path: "/api/system", access: "admin", handler: async () => json(await system()) },
    {
      method: "GET",
      path: "/api/system/diagnostics",
      access: "admin",
      async handler(ctx) {
        const text = await diagnostics(ctx.url.searchParams.get("camera") || null);
        return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
      },
    },
    {
      method: "POST",
      path: "/api/system/workers/:id/restart",
      access: "admin",
      handler(ctx) {
        supervisor.restart(ctx.params.id ?? "", "manual");
        return noContent();
      },
    },
  ];
}
