import { useQuery } from "@tanstack/react-query";
import { settingsQuery } from "../../data/queries.ts";
import { QueryGate } from "../../ui/states.tsx";
import { SettingsLayout } from "../settings/SettingsLayout.tsx";
import { ObjectsGroup } from "./ObjectsGroup.tsx";

/** 設定 → 物件辨識 */
export function ObjectsPage() {
  const settings = useQuery(settingsQuery);
  return (
    <SettingsLayout active="objects">
      <QueryGate queries={[settings]}>{([s]) => <ObjectsGroup settings={s} />}</QueryGate>
    </SettingsLayout>
  );
}
