import { createFileRoute } from "@tanstack/react-router";
import { LABEL_KEY } from "../../../../src/objects/labels.ts";
import { EventsPage, type EventsSearch } from "../../../pages/events/EventsPage.tsx";
import { parseDayKey } from "../../../ui/date-logic.ts";

export const Route = createFileRoute("/_authed/_shell/events")({
  // 路由會把驗證結果疊在原始參數上，所以不合法的值要明確給 undefined 才會蓋掉
  validateSearch: (s: Record<string, unknown>): EventsSearch => ({
    camera: typeof s.camera === "string" && s.camera ? s.camera : undefined,
    date: typeof s.date === "string" ? (parseDayKey(s.date) ?? undefined) : undefined,
    label: typeof s.label === "string" && LABEL_KEY.test(s.label) ? s.label : undefined,
  }),
  component: EventsPage,
});
