import { Trans, useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Settings } from "../../../src/types.ts";
import { api } from "../../api.ts";
import { objectsQuery, settingsQuery } from "../../data/queries.ts";
import { Select } from "../../ui/Select.tsx";
import { SettingRow, SettingsGroup } from "../../ui/SettingRow.tsx";
import { toast } from "../../ui/toast.tsx";
import { DECODE_HINT, decodeNote, decodeOptions } from "./decode-model.ts";
import { videoDevicesQuery } from "./queries.ts";
import "./decode.css";

/** 「設定 → 一般」的影像解碼：自動、處理器，或指定一張顯示卡的硬體解碼器。沒有顯示卡時仍顯示，只有自動與處理器 */
export function DecodeRow({ settings }: { settings: Settings }) {
  const { t, i18n } = useLingui();
  const qc = useQueryClient();
  const video = useQuery(videoDevicesQuery);
  // 物件辨識那邊的型號名稱優先；它沒開時也只是拿來取名，不另外輪詢
  const objectDevices = useQuery({ ...objectsQuery(false), enabled: true }).data?.devices ?? [];
  const save = useMutation({
    mutationFn: (decode: string) => api.updateSettings({ devices: { decode } }),
    onSuccess: (res) => {
      qc.setQueryData(settingsQuery.queryKey, res);
      toast(t`Video decoding settings saved`);
      return qc.invalidateQueries({ queryKey: videoDevicesQuery.queryKey });
    },
  });
  const value = save.isPending ? save.variables : settings.devices.decode;
  const devices = video.data?.devices ?? [];
  const note = video.isPending ? { tone: "muted" as const, text: t`Detecting graphics cards…` } : video.isError && !video.data ? { tone: "muted" as const, text: t`Graphics card information isn't available right now.` } : decodeNote(video.data?.decode ?? null, devices, objectDevices);

  return (
    <SettingsGroup className="obj-group">
      <SettingRow
        title={t`Video decoding`}
        desc={
          <>
            {i18n._(DECODE_HINT)}
            {note ? (
              <small className="hint decode-note" data-tone={note.tone} role="status">
                {note.text}
              </small>
            ) : null}
          </>
        }
        wide
        className="obj-row"
        control={(a) => <Select {...a} label={t`Video decoding`} name="videoDecode" entries={decodeOptions(devices, objectDevices, value)} value={value} disabled={save.isPending} onChange={(v) => save.mutate(v)} />}
      />
    </SettingsGroup>
  );
}
