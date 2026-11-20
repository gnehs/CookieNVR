import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setUnauthorizedHandler } from "./api.ts";
import { createQueryClient } from "./data/query-client.ts";
import { forgetSession, meQuery } from "./data/session.ts";
import { routeTree } from "./routeTree.gen.ts";
import { Spinner } from "./ui/states.tsx";
import { ToastProvider } from "./ui/toast.tsx";
// 順序照舊版 Bun 打包實際套用的順序（Bun 把 index.html 的樣式表倒過來放），同權重的規則才會跟以前一樣誰蓋過誰
import "./ui/form-card.css";
import "./ui/settings-row.css";
import "./ui/date-picker.css";
import "./ui/select.css";
import "./ui/slider.css";
import "./ui/popup.css";
import "./storage.css";
import "./metrics.css";
import "./link.css";
import "./homekit.css";
import "./detect.css";
import "./states.css";
import "./style.css";
import "./ui/overlays.css";


const queryClient = createQueryClient();
const router = createRouter({
  routeTree,
  context: { queryClient },
  scrollRestoration: true,
  defaultPendingComponent: () => <Spinner />,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

setUnauthorizedHandler(() => {
  if (!queryClient.getQueryData(meQuery.queryKey)) return;
  forgetSession(queryClient);
  const here = router.state.location.href;
  void router.navigate({ to: "/login", search: { next: here }, replace: true });
});

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
