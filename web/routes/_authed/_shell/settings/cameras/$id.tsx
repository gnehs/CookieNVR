import { createFileRoute } from "@tanstack/react-router";
import { CameraFormPage } from "../../../../../pages/settings-cameras/CameraFormPage.tsx";

export const Route = createFileRoute("/_authed/_shell/settings/cameras/$id")({
  component: function EditCamera() {
    const { id } = Route.useParams();
    return <CameraFormPage id={id} mode="edit" />;
  },
});
