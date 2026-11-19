import { createFileRoute } from "@tanstack/react-router";
import { parseRecordingsSearch, RecordingsPage } from "../../../pages/recordings/RecordingsPage.tsx";

export const Route = createFileRoute("/_authed/_shell/recordings")({
  validateSearch: parseRecordingsSearch,
  component: RecordingsPage,
});
