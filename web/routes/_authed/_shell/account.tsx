import { createFileRoute } from "@tanstack/react-router";
import { AccountPage } from "../../../pages/account/AccountPage.tsx";

export const Route = createFileRoute("/_authed/_shell/account")({
    component: AccountPage,
});
