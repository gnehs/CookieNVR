import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useEffect } from "react";
import { meQuery } from "../data/session.ts";
import { startStatusStream } from "../data/status-stream.ts";

/** 要登入的頁面（有外殼與沒外殼的都是）：沒登入導到登入頁，登入後回來；全站唯一一條 SSE 在這裡開關 */
export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) throw redirect({ to: "/login", search: { next: location.href }, replace: true });
    return { me };
  },
  component: Authed,
});

function Authed() {
  const qc = useQueryClient();
  const me = useQuery(meQuery).data;
  const admin = me?.role === "admin";
  const signedIn = !!me;
  useEffect(() => (signedIn ? startStatusStream(qc, { admin }) : undefined), [qc, signedIn, admin]);
  // 登入失效時 me 先變成 null，接著才導到登入頁；這段時間不畫任何要登入的內容
  return me ? <Outlet /> : null;
}
