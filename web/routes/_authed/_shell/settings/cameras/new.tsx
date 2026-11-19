import { createFileRoute } from "@tanstack/react-router";
import { NotConverted } from "../../../../../app/NotConverted.tsx";

export const Route = createFileRoute("/_authed/_shell/settings/cameras/new")({
  component: () => <NotConverted title="新增攝影機" legacy="web/legacy/pages/settings-cameras.ts" />,
});
