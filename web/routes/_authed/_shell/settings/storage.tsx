import { createFileRoute } from "@tanstack/react-router";
import { StoragePage } from "../../../../pages/storage/StoragePage.tsx";

export const Route = createFileRoute("/_authed/_shell/settings/storage")({
  component: StoragePage,
});
