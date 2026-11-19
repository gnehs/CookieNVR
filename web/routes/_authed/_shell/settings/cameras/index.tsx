import { createFileRoute } from "@tanstack/react-router";
import { NotConverted } from "../../../../../app/NotConverted.tsx";

export const Route = createFileRoute("/_authed/_shell/settings/cameras/")({
  component: () => <NotConverted title="攝影機設定" legacy="web/legacy/pages/settings-cameras.ts" />,
});
