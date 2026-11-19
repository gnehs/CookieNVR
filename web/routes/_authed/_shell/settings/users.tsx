import { createFileRoute } from "@tanstack/react-router";
import { UsersPage } from "../../../../pages/settings-users/UsersPage.tsx";

export const Route = createFileRoute("/_authed/_shell/settings/users")({
  component: UsersPage,
});
