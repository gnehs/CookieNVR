import { createFileRoute } from "@tanstack/react-router";
import { NotConverted } from "../../../app/NotConverted.tsx";

export const Route = createFileRoute("/_authed/link/$code")({
  component: () => <NotConverted title="連線核准" legacy="web/legacy/pages/link.ts" />,
});
