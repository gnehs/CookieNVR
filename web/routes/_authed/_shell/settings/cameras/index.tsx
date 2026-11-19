import { createFileRoute } from "@tanstack/react-router";
import { CamerasListPage } from "../../../../../pages/settings-cameras/CamerasListPage.tsx";

export const Route = createFileRoute("/_authed/_shell/settings/cameras/")({
  component: CamerasListPage,
});
