import { createFileRoute } from "@tanstack/react-router";
import { CameraPage } from "../../../../pages/camera/CameraPage.tsx";

export const Route = createFileRoute("/_authed/_shell/cameras/$id")({
  component: CameraPage,
});
