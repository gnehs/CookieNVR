import { createFileRoute } from "@tanstack/react-router";
import { CameraFormPage } from "../../../../../pages/settings-cameras/CameraFormPage.tsx";

export const Route = createFileRoute("/_authed/_shell/settings/cameras/new")({
  component: () => <CameraFormPage id={null} mode="new" />,
});
