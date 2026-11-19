import { createFileRoute } from "@tanstack/react-router";
import { NotConverted } from "../../../app/NotConverted.tsx";

export const Route = createFileRoute("/_authed/_shell/account")({
  component: () => <NotConverted title="帳號" legacy="web/legacy/pages/account.ts" />,
});
