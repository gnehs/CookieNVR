import { createFileRoute } from "@tanstack/react-router";
import { NotConverted } from "../../../../app/NotConverted.tsx";

export const Route = createFileRoute("/_authed/_shell/settings/storage")({
  component: () => <NotConverted title="錄影與儲存" legacy="web/legacy/pages/settings-storage.ts" />,
});
