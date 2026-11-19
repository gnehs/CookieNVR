import { createFileRoute } from "@tanstack/react-router";
import { LinkPage } from "../../../pages/link/LinkPage.tsx";

export const Route = createFileRoute("/_authed/link/$code")({
    component: LinkRoute,
});

function LinkRoute() {
  const { code } = Route.useParams();
  return <LinkPage code={code} />;
}
