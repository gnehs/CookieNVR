import { createFileRoute } from "@tanstack/react-router";
import { NotConverted } from "../../../../app/NotConverted.tsx";

export const Route = createFileRoute("/_authed/_shell/cameras/$id")({
  component: () => <NotConverted title="單台攝影機" legacy="web/legacy/pages/camera.ts" />,
});
