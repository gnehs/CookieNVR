import type { Auth } from "../auth/index.ts";
import type { Route } from "../types.ts";
import { adminRoutes, type AdminDeps } from "./admin-routes.ts";
import { authRoutes } from "./auth-routes.ts";
import { cameraRoutes, type CameraDeps } from "./camera-routes.ts";

export interface CoreDeps extends AdminDeps, CameraDeps {
  auth: Auth;
  version: string;
}

export function coreRoutes(deps: CoreDeps): Route[] {
  return [...authRoutes(deps.auth, deps.version, () => deps.settings.get().siteName), ...adminRoutes(deps), ...cameraRoutes(deps)];
}
