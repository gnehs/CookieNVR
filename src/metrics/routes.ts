import { json } from "../http/respond.ts";
import type { Route } from "../types.ts";
import type { Metrics } from "./sampler.ts";

/**
 * Polled rather than pushed over SSE: only the status page needs these numbers, the poll itself tells
 * the sampler someone is looking (so GPU and per-process reads stop when nobody is), and an SSE push
 * would send them to every open page, home included.
 */
export function metricsRoutes(metrics: Metrics): Route[] {
  return [
    {
      method: "GET",
      path: "/api/system/metrics",
      access: "admin",
      handler: async (ctx) => json(await metrics.read({ watch: ctx.url.searchParams.get("watch") === "1" })),
    },
  ];
}
