import { createFileRoute, redirect } from "@tanstack/react-router";
import { recordingsRedirect } from "../../../pages/camera/search.ts";

// 回放併進單台頁之前的網址（書籤、別處貼過來的連結）
export const Route = createFileRoute("/_authed/_shell/recordings")({
  beforeLoad: ({ search }) => {
    const to = recordingsRedirect(search);
    if (!to) throw redirect({ to: "/cameras", replace: true });
    throw redirect({ to: "/cameras/$id", params: { id: to.camera }, search: to.search, replace: true });
  },
});
