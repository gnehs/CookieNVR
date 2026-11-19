import { createFileRoute } from "@tanstack/react-router";
import { NotConverted } from "../../../../app/NotConverted.tsx";

export const Route = createFileRoute("/_authed/_shell/settings/status")({
  component: () => <NotConverted title="狀態" legacy="web/legacy/pages/settings-status.ts" />,
});
