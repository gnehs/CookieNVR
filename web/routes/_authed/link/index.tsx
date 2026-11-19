import { createFileRoute } from "@tanstack/react-router";
import { LinkPage } from "../../../pages/link/LinkPage.tsx";

export const Route = createFileRoute("/_authed/link/")({
    component: () => <LinkPage />,
});
