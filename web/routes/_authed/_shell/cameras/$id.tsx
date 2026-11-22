import { createFileRoute } from "@tanstack/react-router";
import { CameraPage } from "../../../../pages/camera/CameraPage.tsx";
import { parseCameraSearch } from "../../../../pages/camera/search.ts";

export const Route = createFileRoute("/_authed/_shell/cameras/$id")({
  validateSearch: parseCameraSearch,
  component: CameraPage,
});
