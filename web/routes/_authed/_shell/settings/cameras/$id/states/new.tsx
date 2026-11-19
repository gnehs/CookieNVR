import { createFileRoute } from "@tanstack/react-router";
import { NewSensorPage } from "../../../../../../../pages/states/NewSensorPage.tsx";

export const Route = createFileRoute("/_authed/_shell/settings/cameras/$id/states/new")({
  component: function NewSensor() {
    const { id } = Route.useParams();
    return <NewSensorPage cameraId={id} />;
  },
});
