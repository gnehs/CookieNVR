import { createFileRoute } from "@tanstack/react-router";
import { NotConverted } from "../../../app/NotConverted.tsx";

export const Route = createFileRoute("/_authed/_shell/events")({
  component: () => <NotConverted title="事件" legacy="web/legacy/pages/events.ts" />,
});
