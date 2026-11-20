import { useQuery } from "@tanstack/react-query";
import { settingsQuery } from "../../data/queries.ts";
import { ErrorBox, Spinner } from "../../ui/states.tsx";
import { SettingsLayout } from "../settings/SettingsLayout.tsx";
import { ObjectsGroup } from "./ObjectsGroup.tsx";

/** 設定 → 物件辨識 */
export function ObjectsPage() {
  const settings = useQuery(settingsQuery);
  let body;
  if (settings.isPending) body = <Spinner />;
  else if (settings.isError) body = <ErrorBox error={settings.error} onRetry={() => settings.refetch()} />;
  else body = <ObjectsGroup settings={settings.data} />;
  return <SettingsLayout active="objects">{body}</SettingsLayout>;
}
