import { createFileRoute } from "@tanstack/react-router";
import { NotConverted } from "../../../app/NotConverted.tsx";

export const Route = createFileRoute("/_authed/_shell/recordings")({
  component: () => <NotConverted title="錄影" legacy="web/legacy/pages/recordings.ts" />,
});
