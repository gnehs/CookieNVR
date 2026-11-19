import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import type { SettingsDto, SystemDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { camerasQuery, settingsQuery, systemQuery } from "../../data/queries.ts";
import { errMsg, formatBytes } from "../../format.ts";
import { estimateDays } from "../../retention-estimate.ts";
import { Button } from "../../ui/Button.tsx";
import { confirmDialog } from "../../ui/Dialog.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { PresetPicker, SettingRow, SettingsDisclosure, SettingsGroup } from "../../ui/SettingRow.tsx";
import { ErrorBox, Spinner } from "../../ui/states.tsx";
import { toast } from "../../ui/toast.tsx";
import { SettingsLayout } from "../settings/SettingsLayout.tsx";

const GB = 1024 ** 3;
const days = (list: number[]) => [...list.map((d) => ({ value: d, label: `${d} 天` })), { value: 0, label: "不限" }];
const FREE_PRESETS = [2, 5, 10, 20].map((g) => ({ value: g, label: `${g} GB` }));

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
  const free = Number.isFinite(draft.minFreeGb) ? draft.minFreeGb : savedMinFreeGb;
  const est = estimateDays(sys, free * GB);
  const keep = draft.continuousDays;
  if (est === null) {
    return (
      <p className="sto-estimate" aria-live="polite">
        <Icon name="clock" size={17} />
        <span>錄影一段時間後，這裡會估算大約可以存幾天。</span>
      </p>
    );
  }
  const d = Math.floor(est);
  if (keep > d) {
    return (
      <p className="sto-estimate warn" aria-live="polite">
        <Icon name="alert" size={17} />
        <span>
          <b className="num">空間只夠存約 {d} 天</b>，比設定的 {keep} 天少，最舊的錄影會提早刪除。
        </span>
      </p>
    );
  }
  return (
    <p className="sto-estimate" aria-live="polite">
      <Icon name={keep > 0 ? "check-circle" : "hdd"} size={17} />
      <span>
        <b className="num">大約可存 {d} 天</b>
        {keep > 0 ? `的錄影。設定保留 ${keep} 天，空間足夠。` : "的錄影。沒有天數上限，空間不夠時從最舊的開始刪除。"}
      </span>
    </p>
  );
}

type Part = { name: string; bytes: number; kind: "cam" | "orphan" | "other"; shade?: number };

/** 儲存空間總覽：容量條、各攝影機用量。估算放在這張卡裡，但依下面表單目前填的值算 */
function Overview({ sys, names, draft, savedMinFreeGb }: { sys: SystemDto; names: Map<string, string>; draft: Draft; savedMinFreeGb: number }) {
  const qc = useQueryClient();
  const { totalBytes, freeBytes } = sys.disk;
  const live = sys.usage.filter((u) => names.has(u.cameraId)).sort((a, b) => b.bytes - a.bytes);
  const orphanBytes = sys.usage.filter((u) => !names.has(u.cameraId)).reduce((a, u) => a + u.bytes, 0);
  const recorded = sys.usage.reduce((a, u) => a + u.bytes, 0);
  const other = Math.max(0, totalBytes - freeBytes - recorded);
  const pct = (n: number) => (totalBytes > 0 ? (n / totalBytes) * 100 : 0);
  const parts: Part[] = [
    ...live.map((u, i) => ({ name: names.get(u.cameraId)!, bytes: u.bytes, kind: "cam" as const, shade: i % 5 })),
    ...(orphanBytes > 0 ? [{ name: "已刪除的攝影機", bytes: orphanBytes, kind: "orphan" as const }] : []),
    ...(other > 0 ? [{ name: "其他檔案", bytes: other, kind: "other" as const }] : []),
  ];
  const usedPct = Math.round(pct(totalBytes - freeBytes));

  const purge = useMutation({
    mutationFn: () => api.purgeOrphanedRecordings(),
    onSuccess: async (res) => {
      toast(`已清除，釋放 ${formatBytes(res.bytes)}`);
      await qc.invalidateQueries({ queryKey: ["system"] });
    },
  });
  const clearOrphans = async () => {
    const ok = await confirmDialog("清除已刪除攝影機的錄影？", `這些攝影機已經不在了，錄影會立刻永久刪除，無法復原，並釋放 ${formatBytes(orphanBytes)}。其他攝影機的錄影不受影響。`, {
      confirmLabel: "清除錄影",
      danger: true,
    });
    if (ok) purge.mutate();
  };

  return (
    <SettingsGroup title="儲存空間" className="sto">
      <div className="sto-body">
        <div className="sto-top">
          <div className="sto-free">
            <b className="num">{formatBytes(freeBytes)}</b>
            <span>可用</span>
          </div>
          <span className="sto-total num">{`共 ${formatBytes(totalBytes)} · 錄影佔 ${formatBytes(recorded)}`}</span>
        </div>
        <div className="sto-bar" role="img" aria-label={`已用 ${usedPct}%，${parts.map((p) => `${p.name} ${formatBytes(p.bytes)}`).join("、")}，可用 ${formatBytes(freeBytes)}`}>
          {parts.map((p) => (
            <i key={`${p.kind}:${p.name}`} className={`sto-seg ${p.kind}`} data-shade={p.shade} style={{ width: `${Math.max(pct(p.bytes), 0.6).toFixed(2)}%` }} />
          ))}
        </div>
        <Estimate sys={sys} draft={draft} savedMinFreeGb={savedMinFreeGb} />
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
                <Button small variant="danger" aria-label="清除已刪除攝影機的錄影" disabled={purge.isPending} onClick={() => void clearOrphans()}>
                  清除
                </Button>
              ) : null}
            </li>
          ))}
          <li className="sto-item free">
            <i className="sto-swatch sto-seg free" aria-hidden="true" />
            <span className="sto-name">可用</span>
            <span className="sto-size num">{formatBytes(freeBytes)}</span>
          </li>
        </ul>
      ) : (
        <p className="sto-empty">還沒有錄影。</p>
      )}
    </SettingsGroup>
  );
}

function RetentionForm({ settings, draft, setDraft }: { settings: SettingsDto; draft: Draft; setDraft: (f: (d: Draft) => Draft) => void }) {
  const qc = useQueryClient();
  const saved = draftOf(settings);
  const [error, setError] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const pathInput = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Draft>(k: K) => (v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = useMutation({
    mutationFn: (patch: Partial<SettingsDto>) => api.updateSettings(patch),
    onSuccess: (next) => {
      qc.setQueryData(settingsQuery.queryKey, next);
      void qc.invalidateQueries({ queryKey: ["system"] });
      toast("已儲存錄影與儲存設定");
    },
    onError: (e) => setError(errMsg(e)),
  });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    const d = { ...draft, storagePath: draft.storagePath.trim() };
    if (![d.continuousDays, d.eventDays, d.minFreeGb].every((n) => Number.isFinite(n) && n >= 0)) return void setError("天數與空間請填 0 或更大的數字");
    if (!d.storagePath) {
      const details = form.current?.querySelector<HTMLDetailsElement>("details.set-disclosure");
      if (details) details.open = true;
      pathInput.current?.focus();
      return void setError("請填寫儲存位置");
    }
    if (d.storagePath !== saved.storagePath) {
      const ok = await confirmDialog("更改儲存位置？", `新的錄影會存到「${d.storagePath}」。舊的錄影留在原處，仍然可以回放，但不會搬過去。`, { confirmLabel: "更改並儲存" });
      if (!ok) return;
    }
    save.mutate({
      storagePath: d.storagePath,
      retention: { continuousDays: Math.floor(d.continuousDays), eventDays: Math.floor(d.eventDays), minFreeBytes: Math.round(d.minFreeGb * GB) },
    });
  };

  const unchanged = sameDraft({ ...draft, storagePath: draft.storagePath.trim() }, saved);
  const f = draft.minFreeGb;
  return (
    <form ref={form} className="set-form" noValidate onSubmit={(e) => void onSubmit(e)}>
      <SettingsGroup
        title="保留期限"
        desc="超過就自動刪除；空間不夠時，不論天數都會先刪最舊的錄影。"
        foot={
          <>
            <p className="form-error" role="alert">
              {error}
            </p>
            <Button type="submit" variant="primary" disabled={unchanged || save.isPending}>
              儲存變更
            </Button>
          </>
        }
      >
        <SettingRow
          title="連續錄影"
          desc="全天候錄下的影片。"
          control={(a) => <PresetPicker {...a} label="連續錄影" presets={days([3, 7, 14, 30])} initial={saved.continuousDays} unit="天" onChange={set("continuousDays")} />}
        />
        <SettingRow
          title="事件片段"
          desc="偵測到動靜時的片段，通常可以留得比連續錄影久。"
          control={(a) => <PresetPicker {...a} label="事件片段" presets={days([7, 30, 90])} initial={saved.eventDays} unit="天" onChange={set("eventDays")} />}
        />
        <SettingsDisclosure title="進階設定" summary={`保留 ${Number.isFinite(f) ? `${f} GB` : "—"} 空間 · ${draft.storagePath.trim() || "未設定位置"}`}>
          <SettingRow
            title="最低剩餘空間"
            desc="硬碟剩下的空間少於這個值時，先刪除最舊的錄影。"
            control={(a) => <PresetPicker {...a} label="最低剩餘空間" presets={FREE_PRESETS} initial={saved.minFreeGb} unit="GB" step={0.1} onChange={set("minFreeGb")} />}
          />
          <SettingRow
            title="儲存位置"
            desc="錄影存放的資料夾。改了之後新的錄影存到新位置，舊的仍然可以回放。"
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
