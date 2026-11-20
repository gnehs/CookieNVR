import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ObjectModelDto, ObjectsDto } from "../../../src/api-types.ts";
import type { ObjectSettings, Settings } from "../../../src/types.ts";
import { api } from "../../api.ts";
import { objectsQuery, settingsQuery } from "../../data/queries.ts";
import { deviceHint, deviceOptions, FPS_HINT, FPS_OPTIONS, objectsView, unavailableNotes } from "../../detect/object-model.ts";
import { formatBytes } from "../../format.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Select, type SelectOption } from "../../ui/Select.tsx";
import { SettingRow, SettingsGroup } from "../../ui/SettingRow.tsx";
import { Switch } from "../../ui/controls.tsx";
import { toast } from "../../ui/toast.tsx";
import { BenchmarkSection } from "./BenchmarkSection.tsx";

type Patch = { objects?: Partial<ObjectSettings>; devices?: { objects: string } };

const modelLabel = (m: ObjectModelDto) => (m.builtin ? "內建模型" : m.sizeBytes ? `${m.name}（${formatBytes(m.sizeBytes)}）` : m.name);

function Status({ data }: { data: ObjectsDto | undefined }) {
  if (!data) {
    return (
      <div className="set-block obj-block">
        <div className="obj-status" role="status" aria-live="polite">
          <span className="obj-dot" data-tone="busy" />
          <div className="obj-text">
            <b>暫時看不到狀態</b>
            <small>稍後會自動再試。</small>
          </div>
        </div>
      </div>
    );
  }
  const v = objectsView(data.status);
  return (
    <div className="set-block obj-block">
      <div className="obj-status" role="status" aria-live="polite" data-tone={v.tone}>
        {v.tone === "busy" ? <span className="spin" /> : <span className="obj-dot" data-tone={v.tone} />}
        <div className="obj-text">
          <b>{v.title}</b>
          {v.note ? <small>{v.note}</small> : null}
        </div>
      </div>
      <div className="obj-warnings">
        {v.warnings.map((w) => (
          <p className="callout warn" key={w}>
            <Icon name="alert" />
            <span>{w}</span>
          </p>
        ))}
      </div>
    </div>
  );
}

function DeviceNotes({ data, device }: { data: ObjectsDto | undefined; device: string }) {
  const notes = data ? unavailableNotes(data.unavailable, device) : { inline: [], folded: [] };
  return (
    <div className="set-block obj-block obj-notes" hidden={notes.inline.length + notes.folded.length === 0}>
      {notes.inline.map((t) => (
        <p className="callout warn" key={t}>
          <Icon name="alert" />
          <span>{t}</span>
        </p>
      ))}
      {notes.folded.length ? (
        <details className="detect-more obj-details">
          <summary>
            <Icon name="chevron" size={15} />
            找不到你的顯示卡？
          </summary>
          <div className="obj-folded">
            {notes.folded.map((t) => (
              <small className="hint" key={t}>
                {t}
              </small>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** 「設定 → 物件辨識」：開關與狀態，打開後再分成裝置、模型、效能（辨識頻率與測速）三段。變更立刻生效，狀態每幾秒更新 */
export function ObjectsGroup({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const objects = useQuery(objectsQuery(settings.objects.enabled));
  const data = objects.data;

  const apply = useMutation({
    mutationFn: (patch: Patch) => api.updateSettings(patch),
    onSuccess: (res, patch) => {
      qc.setQueryData(settingsQuery.queryKey, res);
      if (patch.objects?.enabled === false) toast("已關閉物件辨識");
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["objects"] }),
  });

  // 送出期間先照新的值畫，失敗時自然回到伺服器的值
  const pending = apply.isPending ? apply.variables : undefined;
  const cur: ObjectSettings = { ...settings.objects, ...pending?.objects };
  const device = pending?.devices?.objects ?? settings.devices.objects;
  const busy = apply.isPending;

  const models: SelectOption<string>[] = (data?.models ?? []).map((m) => ({ value: m.id, label: modelLabel(m) }));
  if (!models.some((o) => o.value === cur.model)) models.push({ value: cur.model, label: `${cur.model}（找不到檔案）` });

  return (
    <div className="stack">
      <SettingsGroup className="obj-group">
        <SettingRow
          title="辨識畫面裡的人、車與動物"
          desc="開啟後，每台攝影機可以選擇只在看到人或車時才記錄事件。會多用一些電腦資源。"
          toggle
          control={(a) => <Switch {...a} checked={cur.enabled} disabled={busy} onChange={(v) => apply.mutate({ objects: { enabled: v } })} />}
        />
        {cur.enabled ? <Status data={data} /> : null}
      </SettingsGroup>
      {cur.enabled ? (
        <>
          <SettingsGroup title="裝置" className="obj-group">
            <SettingRow
              title="推論裝置"
              desc={deviceHint(device, data?.devices ?? [], data?.status.device ?? null)}
              wide
              className="obj-row"
              control={(a) => <Select {...a} label="推論裝置" name="objectDevice" entries={deviceOptions(data?.devices ?? [], device)} value={device} disabled={busy} onChange={(v) => apply.mutate({ devices: { objects: v } })} />}
            />
            <DeviceNotes data={data} device={device} />
          </SettingsGroup>
          <SettingsGroup title="模型" className="obj-group">
            <SettingRow
              title="辨識模型"
              desc={
                <>
                  想用自己的模型，把 .onnx 檔放到 <code className="path">{data?.modelsDir ?? "models"}</code> 資料夾，過幾秒就會出現在選單裡。
                </>
              }
              wide
              className="obj-row"
              control={(a) => <Select {...a} label="辨識模型" name="objectModel" entries={models} value={cur.model} disabled={busy} onChange={(v) => apply.mutate({ objects: { model: v } })} />}
            />
          </SettingsGroup>
          <SettingsGroup title="效能" className="obj-group">
            <SettingRow
              title="每秒辨識幾次"
              desc={FPS_HINT}
              control={(a) => (
                <Select {...a} label="每秒辨識幾次" name="objectFps" entries={FPS_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))} value={String(cur.fps)} disabled={busy} onChange={(v) => apply.mutate({ objects: { fps: Number(v) } })} />
              )}
            />
            <BenchmarkSection data={data} />
          </SettingsGroup>
        </>
      ) : null}
    </div>
  );
}
