import { i18n } from "@lingui/core";
import { plural, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import type { SettingsDto, SystemDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { camerasQuery, settingsQuery, systemQuery } from "../../data/queries.ts";
import { errMsg, formatBytes } from "../../format.ts";
import { DATA_DISK } from "../../health.ts";
import { estimateDays } from "../../retention-estimate.ts";
import { Button } from "../../ui/Button.tsx";
import { confirmDialog } from "../../ui/Dialog.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { PresetPicker, SettingRow, SettingsDisclosure, SettingsGroup } from "../../ui/SettingRow.tsx";
import { ErrorBox, Spinner } from "../../ui/states.tsx";
import { toast } from "../../ui/toast.tsx";
import { SettingsLayout } from "../settings/SettingsLayout.tsx";

const GB = 1024 ** 3;
const days = (list: number[]) => [
  ...list.map((d) => ({
    value: d,
    label: plural(d, { one: "# day", other: "# days" }),
  })),
  { value: 0, label: t`Unlimited` },
];
const listOf = (items: string[]) => new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(items);
const FREE_PRESETS = [2, 5, 10, 20].map((g) => ({
  value: g,
  label: `${g} GB`,
}));

interface Draft {
  continuousDays: number;
  eventDays: number;
  minFreeGb: number;
  storagePath: string;
}

const draftOf = (s: SettingsDto): Draft => ({
  continuousDays: s.retention.continuousDays,
  eventDays: s.retention.eventDays,
  minFreeGb: Math.round((s.retention.minFreeBytes / GB) * 10) / 10,
  storagePath: s.storagePath,
});
const sameDraft = (a: Draft, b: Draft) => a.continuousDays === b.continuousDays && a.eventDays === b.eventDays && a.minFreeGb === b.minFreeGb && a.storagePath === b.storagePath;

/** 設定 → 錄影與儲存 */
export function StoragePage() {
  const { t } = useLingui();
  const settings = useQuery(settingsQuery);
  const sys = useQuery(systemQuery);
  const cams = useQuery(camerasQuery);
  const failed = [settings, sys, cams].find((q) => q.isError);
  return (
    <SettingsLayout active="storage">
      {failed ? (
        <ErrorBox error={failed.error} onRetry={() => void failed.refetch()} />
      ) : !settings.data || !sys.data || !cams.data ? (
        <Spinner />
      ) : (
        <Content settings={settings.data} sys={sys.data} names={new Map(cams.data.map((c) => [c.id as string, c.config.name]))} />
      )}
    </SettingsLayout>
  );
}

function Content({ settings, sys, names }: { settings: SettingsDto; sys: SystemDto; names: Map<string, string> }) {
  const [draft, setDraft] = useState(() => draftOf(settings));
  return (
    <div className="stack">
      <Overview sys={sys} names={names} draft={draft} savedMinFreeGb={draftOf(settings).minFreeGb} />
      <RetentionForm settings={settings} draft={draft} setDraft={setDraft} />
    </div>
  );
}

function Estimate({ sys, draft, savedMinFreeGb }: { sys: SystemDto; draft: Draft; savedMinFreeGb: number }) {
  const { t } = useLingui();
  const free = Number.isFinite(draft.minFreeGb) ? draft.minFreeGb : savedMinFreeGb;
  const est = estimateDays(sys, free * GB);
  const keep = draft.continuousDays;
  if (est === null) {
    return (
      <p className="sto-estimate" aria-live="polite">
        <Icon name="clock" size={17} />
        <span>{t`Once there are some recordings, this will estimate how many days fit.`}</span>
      </p>
    );
  }
  const d = Math.floor(est);
  if (keep > d) {
    return (
      <p className="sto-estimate warn" aria-live="polite">
        <Icon name="alert" size={17} />
        <span>
          <b className="num">
            {plural(d, {
              one: "Space only fits about # day",
              other: "Space only fits about # days",
            })}
          </b>
          {plural(keep, {
            one: ", fewer than the # day you set, so the oldest recordings will be deleted early.",
            other: ", fewer than the # days you set, so the oldest recordings will be deleted early.",
          })}
        </span>
      </p>
    );
  }
  return (
    <p className="sto-estimate" aria-live="polite">
      <Icon name={keep > 0 ? "check-circle" : "hdd"} size={17} />
      <span>
        <b className="num">{plural(d, { one: "About # day fits", other: "About # days fit" })}</b>
        {keep > 0
          ? plural(keep, {
              one: ". You keep recordings for # day, so there's enough space.",
              other: ". You keep recordings for # days, so there's enough space.",
            })
          : t`. There's no day limit; when space runs low, the oldest recordings are deleted first.`}
      </span>
    </p>
  );
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/** 容量條以外要知道的事：appdata 在另一顆的用量、留在舊位置的錄影、另外掛了 /recordings 卻和 appdata 同一顆 */
function DiskNotes({ sys }: { sys: SystemDto }) {
  const { t } = useLingui();
  const data = sys.dataDisk;
  const old = sys.elsewhere.reduce((a, e) => a + e.bytes, 0);
  const dataPath = data.path;
  const dataFree = formatBytes(data.freeBytes);
  const dataTotal = formatBytes(data.totalBytes);
  const notes: {
    icon: "hdd" | "info" | "alert";
    tone?: "warn";
    text: string;
  }[] = [];
  if (!data.sameAsRecordings) {
    const tone = data.freeBytes < DATA_DISK.warnBytes ? "warn" : undefined;
    notes.push({
      icon: tone ? "alert" : "hdd",
      tone,
      text: t`The database, thumbnails and exports live on the appdata disk (${dataPath}): ${dataFree} free of ${dataTotal}.`,
    });
  } else if (!inside(sys.disk.path, data.path)) {
    notes.push({
      icon: "info",
      text: t`Recordings and appdata are actually on the same disk. If you mounted the recordings folder separately to put it on another disk (for example an Unraid array), check that share's primary storage setting.`,
    });
  }
  if (old > 0) {
    const oldPaths = sys.elsewhere.map((e) => e.path);
    const oldCount = oldPaths.length;
    const oldList = listOf(oldPaths);
    const where = oldCount === 1 ? t`the old location ${oldList}` : t`${oldCount} old locations (${oldList})`;
    const oldSize = formatBytes(old);
    notes.push({
      icon: "info",
      text: t`Another ${oldSize} of recordings are in ${where}. They aren't counted in the capacity above; they still play back and are cleared automatically by the retention days.`,
    });
  }
  if (!notes.length) return null;
  return (
    <ul className="sto-notes">
      {notes.map((n) => (
        <li key={n.text} className={n.tone}>
          <Icon name={n.icon} size={16} />
          <span>{n.text}</span>
        </li>
      ))}
    </ul>
  );
}

type Part = {
  name: string;
  bytes: number;
  kind: "cam" | "orphan" | "other";
  shade?: number;
};

/** 儲存空間總覽：容量條、各攝影機用量。估算放在這張卡裡，但依下面表單目前填的值算 */
function Overview({ sys, names, draft, savedMinFreeGb }: { sys: SystemDto; names: Map<string, string>; draft: Draft; savedMinFreeGb: number }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const { totalBytes, freeBytes } = sys.disk;
  const live = sys.usage.filter((u) => names.has(u.cameraId)).sort((a, b) => b.bytes - a.bytes);
  const orphanBytes = sys.usage.filter((u) => !names.has(u.cameraId)).reduce((a, u) => a + u.bytes, 0);
  const recorded = sys.usage.reduce((a, u) => a + u.bytes, 0);
  const other = Math.max(0, totalBytes - freeBytes - recorded);
  const pct = (n: number) => (totalBytes > 0 ? (n / totalBytes) * 100 : 0);
  const parts: Part[] = [
    ...live.map((u, i) => ({
      name: names.get(u.cameraId)!,
      bytes: u.bytes,
      kind: "cam" as const,
      shade: i % 5,
    })),
    ...(orphanBytes > 0
      ? [
          {
            name: t`Deleted cameras`,
            bytes: orphanBytes,
            kind: "orphan" as const,
          },
        ]
      : []),
    ...(other > 0 ? [{ name: t`Other files`, bytes: other, kind: "other" as const }] : []),
  ];
  const usedPct = Math.round(pct(totalBytes - freeBytes));
  const totalText = formatBytes(totalBytes);
  const recordedText = formatBytes(recorded);
  const recordPath = sys.disk.path;
  const freeText = formatBytes(freeBytes);
  const partsText = listOf(parts.map((p) => `${p.name} ${formatBytes(p.bytes)}`));

  const purge = useMutation({
    mutationFn: () => api.purgeOrphanedRecordings(),
    onSuccess: async (res) => {
      const freed = formatBytes(res.bytes);
      toast(t`Cleared, freed ${freed}`);
      await qc.invalidateQueries({ queryKey: ["system"] });
    },
  });
  const clearOrphans = async () => {
    const freed = formatBytes(orphanBytes);
    const ok = await confirmDialog(
      t`Clear recordings of deleted cameras?`,
      t`These cameras no longer exist. Their recordings will be permanently deleted right away, which can't be undone, freeing ${freed}. Recordings of other cameras aren't affected.`,
      {
        confirmLabel: t`Clear recordings`,
        danger: true,
      },
    );
    if (ok) purge.mutate();
  };

  return (
    <SettingsGroup title={t`Storage`} className="sto">
      <div className="sto-body">
        <div className="sto-top">
          <div className="sto-free">
            <b className="num">{formatBytes(freeBytes)}</b>
            <span>{t`Free`}</span>
          </div>
          <span className="sto-total num">{t`${totalText} total · ${recordedText} recorded`}</span>
        </div>
        <p className="sto-where">
          <Trans>
            The disk holding the recording location <code>{recordPath}</code>
          </Trans>
        </p>
        <div className="sto-bar" role="img" aria-label={t`${usedPct}% used, ${partsText}, ${freeText} free`}>
          {parts.map((p) => (
            <i key={`${p.kind}:${p.name}`} className={`sto-seg ${p.kind}`} data-shade={p.shade} style={{ width: `${Math.max(pct(p.bytes), 0.6).toFixed(2)}%` }} />
          ))}
        </div>
        <Estimate sys={sys} draft={draft} savedMinFreeGb={savedMinFreeGb} />
        <DiskNotes sys={sys} />
      </div>
      {live.length || orphanBytes ? (
        <ul className="sto-legend">
          {parts.map((p) => (
            <li key={`${p.kind}:${p.name}`} className={`sto-item ${p.kind}`}>
              <i className={`sto-swatch sto-seg ${p.kind}`} data-shade={p.shade} aria-hidden="true" />
              <span className="sto-name" title={p.name}>
                {p.name}
              </span>
              <span className="sto-size num">{formatBytes(p.bytes)}</span>
              {p.kind === "orphan" ? (
                <Button small variant="danger" aria-label={t`Clear recordings of deleted cameras`} disabled={purge.isPending} onClick={() => void clearOrphans()}>
                  {t`Clear`}
                </Button>
              ) : null}
            </li>
          ))}
          <li className="sto-item free">
            <i className="sto-swatch sto-seg free" aria-hidden="true" />
            <span className="sto-name">{t`Free`}</span>
            <span className="sto-size num">{formatBytes(freeBytes)}</span>
          </li>
        </ul>
      ) : (
        <p className="sto-empty">{t`No recordings yet.`}</p>
      )}
    </SettingsGroup>
  );
}

function RetentionForm({ settings, draft, setDraft }: { settings: SettingsDto; draft: Draft; setDraft: (f: (d: Draft) => Draft) => void }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const saved = draftOf(settings);
  const [error, setError] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const pathInput = useRef<HTMLInputElement>(null);
  const set =
    <K extends keyof Draft>(k: K) =>
    (v: Draft[K]) =>
      setDraft((d) => ({ ...d, [k]: v }));

  const save = useMutation({
    mutationFn: (patch: Partial<SettingsDto>) => api.updateSettings(patch),
    onSuccess: (next) => {
      qc.setQueryData(settingsQuery.queryKey, next);
      void qc.invalidateQueries({ queryKey: ["system"] });
      toast(t`Recording and storage settings saved`);
    },
    onError: (e) => setError(errMsg(e)),
  });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    const d = { ...draft, storagePath: draft.storagePath.trim() };
    if (![d.continuousDays, d.eventDays, d.minFreeGb].every((n) => Number.isFinite(n) && n >= 0)) return void setError(t`Enter 0 or a larger number for days and space`);
    if (!d.storagePath) {
      const details = form.current?.querySelector<HTMLDetailsElement>("details.set-disclosure");
      if (details) details.open = true;
      pathInput.current?.focus();
      return void setError(t`Enter a storage location`);
    }
    if (d.storagePath !== saved.storagePath) {
      const newPath = d.storagePath;
      const ok = await confirmDialog(
        t`Change the storage location?`,
        t`New recordings will be saved to "${newPath}". Old recordings stay where they are and can still be played back, but they won't be moved.`,
        { confirmLabel: t`Change and save` },
      );
      if (!ok) return;
    }
    save.mutate({
      ...(d.storagePath !== saved.storagePath ? { storagePath: d.storagePath } : {}),
      retention: {
        continuousDays: Math.floor(d.continuousDays),
        eventDays: Math.floor(d.eventDays),
        minFreeBytes: Math.round(d.minFreeGb * GB),
      },
    });
  };

  const unchanged = sameDraft({ ...draft, storagePath: draft.storagePath.trim() }, saved);
  const f = draft.minFreeGb;
  const keepFree = Number.isFinite(f) ? `${f} GB` : "—";
  const pathText = draft.storagePath.trim() || t`No location set`;
  return (
    <form ref={form} className="set-form" noValidate onSubmit={(e) => void onSubmit(e)}>
      <SettingsGroup
        title={t`Retention`}
        desc={t`Recordings older than this are deleted automatically. When space runs low, the oldest recordings go first, whatever the days say.`}
        foot={
          <>
            <p className="form-error" role="alert">
              {error}
            </p>
            <Button type="submit" variant="primary" disabled={unchanged || save.isPending}>
              {t`Save changes`}
            </Button>
          </>
        }
      >
        <SettingRow
          title={t`Continuous recording`}
          desc={t`Video recorded around the clock.`}
          control={(a) => (
            <PresetPicker {...a} label={t`Continuous recording`} presets={days([3, 7, 14, 30])} initial={saved.continuousDays} unit={t`days`} onChange={set("continuousDays")} />
          )}
        />
        <SettingRow
          title={t`Event clips`}
          desc={t`Clips recorded when motion is detected. They can usually be kept longer than continuous recording.`}
          control={(a) => <PresetPicker {...a} label={t`Event clips`} presets={days([7, 30, 90])} initial={saved.eventDays} unit={t`days`} onChange={set("eventDays")} />}
        />
        <SettingsDisclosure title={t`Advanced`} summary={t`Keep ${keepFree} free · ${pathText}`}>
          <SettingRow
            title={t`Minimum free space`}
            desc={t`When the disk has less free space than this, the oldest recordings are deleted first.`}
            control={(a) => <PresetPicker {...a} label={t`Minimum free space`} presets={FREE_PRESETS} initial={saved.minFreeGb} unit="GB" step={0.1} onChange={set("minFreeGb")} />}
          />
          <SettingRow
            title={t`Storage location`}
            desc={t`The folder where recordings are stored. After you change it, new recordings go to the new location and old ones can still be played back.`}
            wide
            control={(a) => (
              <input
                {...a}
                ref={pathInput}
                type="text"
                name="storagePath"
                required
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                value={draft.storagePath}
                onChange={(e) => set("storagePath")(e.currentTarget.value)}
              />
            )}
          />
        </SettingsDisclosure>
      </SettingsGroup>
    </form>
  );
}
