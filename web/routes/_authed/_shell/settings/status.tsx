import { createFileRoute } from "@tanstack/react-router";
import { StatusPage } from "../../../../pages/status/StatusPage.tsx";

export const Route = createFileRoute("/_authed/_shell/settings/status")({
  component: StatusPage,
});
