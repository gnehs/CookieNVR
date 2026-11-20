import { createFileRoute } from "@tanstack/react-router";
import { ObjectsPage } from "../../../../pages/settings-system/ObjectsPage.tsx";

export const Route = createFileRoute("/_authed/_shell/settings/objects")({
  component: ObjectsPage,
});
