import { createFileRoute } from "@tanstack/react-router";
import { requireAdmin } from "../../data/session.ts";
import { CameraFormPage } from "../../pages/settings-cameras/CameraFormPage.tsx";

export const Route = createFileRoute("/_authed/welcome")({
  beforeLoad: requireAdmin,
  component: () => <CameraFormPage id={null} mode="welcome" />,
});
