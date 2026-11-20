import { i18n } from "@lingui/core";
import { I18nProvider, useLingui } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setUnauthorizedHandler } from "./api.ts";
import { activateLocale } from "./i18n.ts";
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

/** 換語言時整棵重掛：模組外層的 t\`\` 與命令式物件（時間軸、遮罩編輯器）的文字才會跟著換 */
function LocalizedApp() {
  const { i18n } = useLingui();
  return (
    <ToastProvider key={i18n.locale}>
      <RouterProvider router={router} />
    </ToastProvider>
  );
}

await activateLocale();

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <LocalizedApp />
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>,
);
