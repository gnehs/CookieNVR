import { createFileRoute, Outlet } from "@tanstack/react-router";
import { requireAdmin } from "../../../../data/session.ts";

/** 設定底下全部是管理員專屬 */
export const Route = createFileRoute("/_authed/_shell/settings")({
  beforeLoad: requireAdmin,
  component: Outlet,
});
