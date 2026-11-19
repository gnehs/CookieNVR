import { createFileRoute } from "@tanstack/react-router";
import { Shell } from "../../app/Shell.tsx";

/** 有側欄（手機是底部導覽列）的頁面 */
export const Route = createFileRoute("/_authed/_shell")({
  component: Shell,
});
