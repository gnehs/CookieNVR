import { t as msgT } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
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
import { ObjectsEmpty } from "./ObjectsEmpty.tsx";

type Patch = { objects?: Partial<ObjectSettings>; devices?: { objects: string } };

const missingFile = (model: string): string => msgT`${model} (file not found)`;

const modelLabel = (m: ObjectModelDto): string => {
  if (m.builtin) return msgT`Built-in model`;
  if (!m.sizeBytes) return m.name;
  const name = m.name;
  const size = formatBytes(m.sizeBytes);
  return msgT`${name} (${size})`;
};

function Status({ data }: { data: ObjectsDto | undefined }) {
  const { t } = useLingui();
  if (!data) {
    return (
      <div className="set-block obj-block">
        <div className="obj-status" role="status" aria-live="polite">
          <span className="obj-dot" data-tone="busy" />
          <div className="obj-text">
            <b>{t`Status isn't available right now`}</b>
            <small>{t`It will try again automatically in a moment.`}</small>
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
  const { t } = useLingui();
  const notes = data ? unavailableNotes(data.unavailable, device, data.unavailableMsg) : { inline: [], folded: [] };
  return (
    <div className="set-block obj-block obj-notes" hidden={notes.inline.length + notes.folded.length === 0}>
      {notes.inline.map((n) => (
        <p className="callout warn" key={n}>
          <Icon name="alert" />
          <span>{n}</span>
        </p>
      ))}
      {notes.folded.length ? (
        <details className="detect-more obj-details">
          <summary>
            <Icon name="chevron" size={15} />
            {t`Can't find your graphics card?`}
          </summary>
          <div className="obj-folded">
            {notes.folded.map((n) => (
              <small className="hint" key={n}>
                {n}
              </small>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** 「設定 → 物件辨識」：還沒開時是一張 empty state；開了之後是開關與狀態，再分成裝置、模型、效能（辨識頻率與測速）三段。變更立刻生效，狀態每幾秒更新 */
export function ObjectsGroup({ settings }: { settings: Settings }) {
  const { t, i18n } = useLingui();
  const qc = useQueryClient();
  const objects = useQuery(objectsQuery(settings.objects.enabled));
  const data = objects.data;

  const apply = useMutation({
    mutationFn: (patch: Patch) => api.updateSettings(patch),
    onSuccess: (res, patch) => {
      qc.setQueryData(settingsQuery.queryKey, res);
      if (patch.objects?.enabled === false) toast(t`Object detection turned off`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["objects"] }),
  });

  // 送出期間先照新的值畫，失敗時自然回到伺服器的值
  const pending = apply.isPending ? apply.variables : undefined;
  const cur: ObjectSettings = { ...settings.objects, ...pending?.objects };
  const device = pending?.devices?.objects ?? settings.devices.objects;
  const busy = apply.isPending;
  const modelsDir = data?.modelsDir ?? "models";

  const models: SelectOption<string>[] = (data?.models ?? []).map((m) => ({ value: m.id, label: modelLabel(m) }));
  if (!models.some((o) => o.value === cur.model)) models.push({ value: cur.model, label: missingFile(cur.model) });

  if (!cur.enabled) return <ObjectsEmpty busy={busy} onEnable={() => apply.mutate({ objects: { enabled: true } })} />;

  return (
    <div className="stack">
      <SettingsGroup className="obj-group">
        <SettingRow
          title={t`Recognize people, vehicles and animals in the picture`}
          desc={t`Once on, each camera can choose to record events only when it sees a person or vehicle. It uses some extra computer resources.`}
          toggle
          control={(a) => <Switch {...a} checked={cur.enabled} disabled={busy} onChange={(v) => apply.mutate({ objects: { enabled: v } })} />}
        />
        <Status data={data} />
      </SettingsGroup>
      <SettingsGroup title={t`Device`} className="obj-group">
        <SettingRow
          title={t`Inference device`}
          desc={deviceHint(device, data?.devices ?? [], data?.status.device ?? null)}
          wide
          className="obj-row"
          control={(a) => <Select {...a} label={t`Inference device`} name="objectDevice" entries={deviceOptions(data?.devices ?? [], device)} value={device} disabled={busy} onChange={(v) => apply.mutate({ devices: { objects: v } })} />}
        />
        <DeviceNotes data={data} device={device} />
      </SettingsGroup>
      <SettingsGroup title={t`Model`} className="obj-group">
        <SettingRow
          title={t`Detection model`}
          desc={
            <>
              <Trans>To use your own model, put the .onnx file in the <code className="path">{modelsDir}</code> folder and it will show up in the menu within a few seconds.</Trans>
            </>
          }
          wide
          className="obj-row"
          control={(a) => <Select {...a} label={t`Detection model`} name="objectModel" entries={models} value={cur.model} disabled={busy} onChange={(v) => apply.mutate({ objects: { model: v } })} />}
        />
      </SettingsGroup>
      <SettingsGroup title={t`Performance`} className="obj-group">
        <SettingRow
          title={t`Detections per second`}
          desc={i18n._(FPS_HINT)}
          control={(a) => (
            <Select {...a} label={t`Detections per second`} name="objectFps" entries={FPS_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))} value={String(cur.fps)} disabled={busy} onChange={(v) => apply.mutate({ objects: { fps: Number(v) } })} />
          )}
        />
        <BenchmarkSection data={data} />
      </SettingsGroup>
    </div>
  );
}
