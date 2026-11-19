import { createFileRoute } from "@tanstack/react-router";
import { SensorPage } from "../../../../../../../pages/states/SensorPage.tsx";

export const Route = createFileRoute("/_authed/_shell/settings/cameras/$id/states/$sensorId")({
  component: function Sensor() {
    const { id, sensorId } = Route.useParams();
    return <SensorPage cameraId={id} sensorId={sensorId} />;
  },
});
