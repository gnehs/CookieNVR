import { createFileRoute } from "@tanstack/react-router";
import { SystemPage } from "../../../../pages/settings-system/SystemPage.tsx";

export const Route = createFileRoute("/_authed/_shell/settings/system")({
  component: SystemPage,
});
