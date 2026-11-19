import { useQuery, type QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Navigate, Outlet, redirect, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { infoQuery } from "../data/session.ts";
import { ConfirmHost } from "../ui/Dialog.tsx";
import { ErrorBox } from "../ui/states.tsx";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  beforeLoad: async ({ context, location }) => {
    const info = await context.queryClient.ensureQueryData(infoQuery);
    if (info.needsSetup && location.pathname !== "/setup") throw redirect({ to: "/setup", replace: true });
  },
  component: Root,
  errorComponent: BootError,
  // 不存在的網址：跟舊版一樣回首頁（沒登入的話首頁會再導到登入）
  notFoundComponent: () => <Navigate to="/cameras" replace />,
});

function Root() {
  const siteName = useQuery(infoQuery).data?.siteName ?? "CookieNVR";
  useEffect(() => {
    document.title = siteName;
  }, [siteName]);
  return (
    <>
      <Outlet />
      <ConfirmHost />
    </>
  );
}

function BootError({ error }: { error: unknown }) {
  const router = useRouter();
  return (
    <div className="auth">
      <ErrorBox error={error} onRetry={() => void router.invalidate()} />
    </div>
  );
}
