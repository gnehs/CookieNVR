import { createFileRoute } from "@tanstack/react-router";
import { NotConverted } from "../../../../app/NotConverted.tsx";

export const Route = createFileRoute("/_authed/_shell/settings/system")({
  component: () => <NotConverted title="一般設定" legacy="web/legacy/pages/settings-system.ts" />,
});
