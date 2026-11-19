import { createFileRoute } from "@tanstack/react-router";
import { NotConverted } from "../../../../app/NotConverted.tsx";

export const Route = createFileRoute("/_authed/_shell/settings/users")({
  component: () => <NotConverted title="使用者" legacy="web/legacy/pages/settings-users.ts" />,
});
