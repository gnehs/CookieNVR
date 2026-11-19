import { createFileRoute } from "@tanstack/react-router";
import { CamerasPage } from "../../../../pages/cameras/CamerasPage.tsx";

export const Route = createFileRoute("/_authed/_shell/cameras/")({
  component: CamerasPage,
});
