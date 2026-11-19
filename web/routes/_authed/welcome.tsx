import { createFileRoute } from "@tanstack/react-router";
import { NotConverted } from "../../app/NotConverted.tsx";
import { requireAdmin } from "../../data/session.ts";

export const Route = createFileRoute("/_authed/welcome")({
  beforeLoad: requireAdmin,
  component: () => <NotConverted title="新增攝影機" legacy="web/legacy/pages/settings-cameras.ts（cameraFormPage 的 welcome 模式）" />,
});
