import { createFileRoute, redirect } from "@tanstack/react-router";
import { meQuery, safeNext } from "../data/session.ts";
import { LoginPage } from "../pages/auth/AuthPage.tsx";

export const Route = createFileRoute("/login")({
  validateSearch: (s: Record<string, unknown>): { next?: string } => {
    const next = safeNext(s.next);
    return next ? { next } : {};
  },
  beforeLoad: async ({ context, search }) => {
    if (await context.queryClient.ensureQueryData(meQuery)) throw redirect({ href: search.next ?? "/cameras", replace: true });
  },
  component: LoginPage,
});
