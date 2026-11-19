import { createFileRoute, redirect } from "@tanstack/react-router";
import { infoQuery } from "../data/session.ts";
import { SetupPage } from "../pages/auth/AuthPage.tsx";

export const Route = createFileRoute("/setup")({
  beforeLoad: async ({ context }) => {
    if (!(await context.queryClient.ensureQueryData(infoQuery)).needsSetup) throw redirect({ to: "/login", replace: true });
  },
  component: SetupPage,
});
