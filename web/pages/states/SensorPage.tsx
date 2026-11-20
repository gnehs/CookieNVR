import { plural, t as tc } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { i18n } from "@lingui/core";
import { useEffect, useRef, useState } from "react";
import type { CameraDto, CropBox, StateSensorDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { camerasQuery } from "../../data/queries.ts";
import { errMsg, formatDateTime } from "../../format.ts";
import { serverText } from "../../server-text.ts";
import { JobBar, StateLine, useNow } from "../../states/bits.tsx";
import { ClassesEditor } from "../../states/ClassesEditor.tsx";
import { CropEditor } from "../../states/CropEditor.tsx";
import { classesError, jobActive, MAX_NAME, needsText, planClassEdit, resultSummary, rowsOf, sensorNameError, sensorView, sinceText, THRESHOLD_PRESETS, trainStatus, type ClassRow } from "../../states/model.ts";
import { onSensorMessage, onSensorRemoved, stateChangesQuery, statesQuery } from "../../states/queries.ts";
import { Button, CopyButton } from "../../ui/Button.tsx";
import { Choice, Switch } from "../../ui/controls.tsx";
import { confirmDialog } from "../../ui/Dialog.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { SettingRow } from "../../ui/SettingRow.tsx";
import { ErrorBox, PageError, Spinner } from "../../ui/states.tsx";
import { toast } from "../../ui/toast.tsx";
import { SettingsSubpage } from "../settings/SettingsLayout.tsx";
import { LabelBoard } from "./LabelBoard.tsx";

/** 一個狀態感應器：目前狀態、訓練、標記、最近的切換、設定與刪除 */
export function SensorPage({ cameraId, sensorId }: { cameraId: string; sensorId: string }) {
  const { t } = useLingui();
  const sensors = useQuery(statesQuery);
  const cams = useQuery(camerasQuery);
  // 刪除後快取裡已經沒有它，但還沒換頁；別閃一下「找不到」
  const last = useRef<StateSensorDto | null>(null);
  if (sensors.isPending || cams.isPending) return <Spinner />;
  const failed = sensors.isError ? sensors : cams.isError ? cams : null;
  if (failed) return <ErrorBox error={failed.error} onRetry={() => void failed.refetch()} />;
  const cam = cams.data!.find((c) => c.id === cameraId);
  const sensor = sensors.data!.find((s) => s.id === sensorId && s.cameraId === cameraId) ?? (last.current?.id === sensorId ? last.current : null);
  if (!cam || !sensor) return <ErrorBox error={new PageError(t`Sensor not found`, t`It may have been deleted.`, { label: t`Back to camera settings`, to: cam ? `/settings/cameras/${cam.id}` : "/settings/cameras" })} />;
  last.current = sensor;
  return <Sensor key={sensor.id} cam={cam} sensor={sensor} />;
}

function Sensor({ cam, sensor }: { cam: CameraDto; sensor: StateSensorDto }) {
  return (
    <SettingsSubpage title={sensor.config.name} back={`/settings/cameras/${cam.id}`}>
      <div className="stack st-page">
        <Hero cam={cam} sensor={sensor} />
        <TrainCard cam={cam} sensor={sensor} />
        <LabelBoard sensor={sensor} />
        {sensor.model ? <History sensor={sensor} /> : null}
        <Settings cam={cam} sensor={sensor} />
        <Danger cam={cam} sensor={sensor} />
      </div>
    </SettingsSubpage>
  );
}

/** 最上面：現在是什麼狀態、從什麼時候開始；沒在辨識時說原因與下一步 */
function Hero({ cam, sensor }: { cam: CameraDto; sensor: StateSensorDto }) {
  const { t } = useLingui();
  const now = useNow();
  const v = sensorView(sensor);
  const candidate = v.kind === "state" ? v.candidate : null;
  const since = v.kind === "state" ? sinceText(v.since, now) : "";
  const job = sensor.job;
  const recentJob = job && (job.state === "done" || job.state === "failed") && job.kind !== "train" && now - job.finishedAt < 15 * 60_000 ? job : null;
  return (
    <section className="card st-hero" aria-label={t`Current state`}>
      <div className="st-hero-main">
        <span className="hint">{cam.config.name}</span>
        {v.kind === "state" ? (
          <>
            <p className="st-big">{v.label}</p>
            <p className="st-hero-sub" title={formatDateTime(v.since)}>
              {candidate ? t`Last switched: ${since}, now checking whether it became “${candidate}”` : t`Last switched: ${since}`}
            </p>
          </>
        ) : (
          <>
            <StateLine sensor={sensor} now={now} />
            <p className="st-hero-sub">{heroHint(sensor)}</p>
          </>
        )}
      </div>
      {job && (job.state === "queued" || job.state === "running") && job.kind !== "train" ? <JobBar job={job} /> : null}
      {recentJob?.state === "done" ? (
        <p className="callout ok">
          <Icon name="check-circle" size={16} />
          <span>{serverText(recentJob.msg, recentJob.message)}</span>
        </p>
      ) : recentJob?.state === "failed" ? (
        <p className="callout bad">
          <Icon name="alert" size={16} />
          <span>{serverText(recentJob.errorMsg, recentJob.error)}</span>
        </p>
      ) : null}
    </section>
  );
}

function heroHint(s: StateSensorDto): string {
  const v = sensorView(s);
  if (v.kind === "confirming") return tc`It settles once it sees the same state several times in a row, usually within a few dozen seconds.`;
  if (v.kind === "paused") return s.problem?.code === "disabled" ? tc`Turn on “Detection” in the settings below to resume.` : tc`It will resume once the picture settles.`;
  if (v.kind !== "problem") return "";
  switch (v.code) {
    case "untrained":
      return s.trainable ? tc`Every class has pictures. Press “Start training”.` : tc`Label pictures below. Once every class has some, you can train.`;
    case "stale-model":
      return tc`Classes changed. Detection resumes after retraining.`;
    case "camera-off":
      return tc`The camera has no picture. Detection resumes once it connects.`;
    case "worker":
      return v.message;
  }
}

/** 訓練：每類的張數、還差幾張、開始訓練與進度，完成後用白話說結果 */
function TrainCard({ cam, sensor }: { cam: CameraDto; sensor: StateSensorDto }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const [starting, setStarting] = useState(false);
  const status = trainStatus(sensor);
  const job = sensor.job;
  const training = job?.kind === "train" && (job.state === "queued" || job.state === "running") ? job : null;
  const failed = job?.kind === "train" && job.state === "failed" ? job : null;
  const failedError = failed ? serverText(failed.errorMsg, failed.error) : "";
  const needs = needsText(sensor);
  const m = sensor.model;
  const result = m ? resultSummary(m) : null;
  const busy = jobActive(sensor) || starting;
  const trainedAt = m ? formatDateTime(m.trainedAt) : "";
  const trainedCount = m ? m.counts.reduce((n, c) => n + c.count, 0) : 0;
  const primary = status !== "current";

  const train = async () => {
    setStarting(true);
    try {
      onSensorMessage(qc, await api.trainState(sensor.id));
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="card st-train" aria-labelledby="train-title">
      <header className="st-train-head">
        <h2 id="train-title" className="card-title">
          {m ? t`Detection accuracy` : t`Training`}
        </h2>
        <Button variant={primary ? "primary" : undefined} small={!primary} icon="refresh" iconSize={15} disabled={busy || !sensor.trainable} onClick={() => void train()}>
          {m ? t`Retrain` : t`Start training`}
        </Button>
      </header>
      <div className="st-counts" role="list" aria-label={t`Images labeled per class`}>
        {sensor.images.labeled.map((l) => (
          <span key={l.label} role="listitem" className="st-count" data-short={l.count < 2 ? "" : undefined}>
            <b>{l.label}</b>
            <span className="num">
              <Plural value={l.count} one="# image" other="# images" />
            </span>
          </span>
        ))}
      </div>
      {training ? <JobBar job={training} /> : null}
      {!training && needs ? <p className="hint st-needs">{needs}. <Trans>Sort the unlabeled pictures below into classes.</Trans></p> : null}
      {!training && !needs && status === "stale" ? (
        <p className="callout warn">
          <Icon name="alert" size={16} />
          <span>
            <Trans>Classes changed. Detection resumes after retraining.</Trans>
          </span>
        </p>
      ) : null}
      {!training && !needs && status === "outdated" ? <p className="hint">
          <Trans>The labels differ from the last training. Retrain to use the new labels.</Trans>
        </p> : null}
      {!training && !needs && status === "untrained" ? <p className="hint">
          <Trans>Every class has pictures. Training takes a few seconds to a few dozen, and detection starts right after.</Trans>
        </p> : null}
      {failed && !training ? (
        <p className="callout bad">
          <Icon name="alert" size={16} />
          <span>{t`Training failed: ${failedError}`}</span>
        </p>
      ) : null}
      {m && result && !training ? (
        <div className="st-result">
          <p className="st-result-head">
            <Icon name="check-circle" size={18} />
            <b>{result.headline}</b>
          </p>
          {result.perClass.length ? (
            <ul className="st-bars">
              {result.perClass.map((p) => (
                <li key={p.label}>
                  <span className="st-bar-label">{p.label}</span>
                  <span className="st-bar" aria-hidden="true">
                    <i style={{ width: `${p.pct}%` }} data-low={p.pct < 90 ? "" : undefined} />
                  </span>
                  <span className="num st-bar-num">
                    {p.correct}/{p.total}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <details className="more">
            <summary>{t`Details`}</summary>
            <div className="st-detail">
              {result.mistakes.length ? (
                <ul>
                  {result.mistakes.map((x) => (
                    <li key={`${x.actual}>${x.predicted}`}>{mistakeText(x)}</li>
                  ))}
                </ul>
              ) : (
                <p>
                  <Trans>No pictures were misread during checking.</Trans>
                </p>
              )}
              <p className="hint">
                {t`The checking pictures weren’t used for learning, so detection saw them for the first time, just like in real use. Trained ${trainedAt} on ${trainedCount} images. Mistakes are mostly from different lighting or in-between frames; label a few more like them and retrain to improve.`}
              </p>
              <CopyButton label={t`Copy diagnostics`} className="small" getText={() => api.diagnostics(cam.id)} done={t`Diagnostics copied. You can paste them to an AI or a technician.`} />
            </div>
          </details>
        </div>
      ) : null}
    </section>
  );
}

function mistakeText({ count, actual, predicted }: { count: number; actual: string; predicted: string }): string {
  return plural(count, { one: `# image of “${actual}” was read as “${predicted}”`, other: `# images of “${actual}” were read as “${predicted}”` });
}

/** 最近的狀態切換，附切換當下的畫面 */
function History({ sensor }: { sensor: StateSensorDto }) {
  const q = useQuery(stateChangesQuery(sensor.id));
  const now = useNow();
  const [all, setAll] = useState(false);
  const list = (q.data ?? []).slice(0, all ? undefined : 8);
  const more = (q.data?.length ?? 0) > 8 && !all;
  return (
    <section className="card st-history" aria-labelledby="hist-title">
      <h2 id="hist-title" className="card-title">
        <Trans>Recent changes</Trans>
      </h2>
      {q.isPending ? (
        <p className="hint st-pad">
          <span className="spin" aria-hidden="true" /> <Trans>Loading…</Trans>
        </p>
      ) : list.length === 0 ? (
        <p className="hint st-pad"><Trans>No changes yet. State changes will be logged here.</Trans></p>
      ) : (
        <ol className="st-changes">
          {list.map((c) => (
            <li key={c.id}>
              {c.thumbUrl ? <img src={c.thumbUrl} alt="" loading="lazy" decoding="async" /> : <span className="st-thumb-ph" aria-hidden="true" />}
              <span className="st-change-text">
                <span>
                  {c.from ? <span className="muted">{c.from} → </span> : null}
                  <b>{c.to}</b>
                </span>
                <time className="hint" dateTime={new Date(c.at).toISOString()} title={formatDateTime(c.at)}>
                  {sinceText(c.at, now)}
                </time>
              </span>
            </li>
          ))}
        </ol>
      )}
      {more ? (
        <div className="st-pad">
          <Button small variant="ghost" onClick={() => setAll(true)}>
            <Trans>Show more</Trans>
          </Button>
        </div>
      ) : null}
    </section>
  );
}

interface Draft {
  name: string;
  rows: ClassRow[];
  crop: CropBox;
  threshold: number;
  intervalSec: number;
  onMotion: boolean;
  enabled: boolean;
}

const draftOf = (s: StateSensorDto): Draft => ({ ...s.config, rows: rowsOf(s.config.classes) });
const sameDraft = (a: Draft, b: Draft) =>
  JSON.stringify({ ...a, rows: a.rows.map((r) => [r.original, r.name.trim()]) }) === JSON.stringify({ ...b, rows: b.rows.map((r) => [r.original, r.name.trim()]) });

/** 設定：名稱、類別、區域、判斷方式；按「儲存」才送出 */
function Settings({ cam, sensor }: { cam: CameraDto; sensor: StateSensorDto }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const [base, setBase] = useState(() => draftOf(sensor));
  const [draft, setDraft] = useState(base);
  const [cropOpen, setCropOpen] = useState(false);
  const [error, setError] = useState<{ message: string; index?: number | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = !sameDraft(draft, base);
  // 別處改了設定（例如匯入時加了類別）：還沒動過就跟著更新
  const seen = useRef(JSON.stringify(sensor.config));
  useEffect(() => {
    const now = JSON.stringify(sensor.config);
    if (now === seen.current) return;
    seen.current = now;
    if (dirty || saving) return;
    const next = draftOf(sensor);
    setBase(next);
    setDraft(next);
  });
  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError(null);
  };
  const counts = new Map(sensor.images.labeled.map((l) => [l.label, l.count]));

  const save = async () => {
    const n = sensorNameError(draft.name);
    if (n) return setError({ message: n });
    const c = classesError(draft.rows.map((r) => r.name));
    if (c) return setError({ message: c.message, index: c.index });
    if (!Number.isFinite(draft.threshold) || draft.threshold < 0.5 || draft.threshold > 0.99) return setError({ message: t`Confidence must be between 50% and 99%` });
    if (!Number.isInteger(draft.intervalSec) || draft.intervalSec < 0 || draft.intervalSec > 3600) return setError({ message: t`The interval must be a whole number from 0 to 3600 seconds` });
    const original = sensor.config.classes;
    const plan = planClassEdit(original, draft.rows);
    const lost = plan.removed.reduce((sum, r) => sum + (counts.get(r) ?? 0), 0);
    const added = draft.rows.some((r) => r.original === null);
    const removedList = new Intl.ListFormat(i18n.locale, { type: "conjunction", style: "narrow" }).format(plan.removed);
    const lostMessage = plural(lost, {
      one: "# labeled image of the deleted classes will go back to unlabeled. Retrain afterward to resume detection.",
      other: "# labeled images of the deleted classes will go back to unlabeled. Retrain afterward to resume detection.",
    });
    if (plan.removed.length && !(await confirmDialog(t`Delete “${removedList}”?`, lost ? lostMessage : t`After deleting classes, retrain to resume detection.`, { confirmLabel: t`Delete and save`, danger: true }))) return;
    if (!plan.removed.length && added && sensor.model && !(await confirmDialog(t`Add a class?`, t`After adding a class, label pictures for it and retrain. Detection stays paused until then.`, { confirmLabel: t`Save` }))) return;
    setSaving(true);
    try {
      const common = { name: draft.name.trim(), crop: draft.crop, threshold: draft.threshold, intervalSec: draft.intervalSec, onMotion: draft.onMotion, enabled: draft.enabled };
      if (plan.removed.length) onSensorMessage(qc, await api.updateState(sensor.id, { ...sensor.config, classes: original.filter((x) => !plan.removed.includes(x)) }));
      for (const r of plan.renames) onSensorMessage(qc, await api.renameStateClass(sensor.id, r.from, r.to));
      const saved = await api.updateState(sensor.id, { ...common, classes: plan.classes });
      onSensorMessage(qc, saved);
      const next = draftOf(saved);
      setBase(next);
      setDraft(next);
      setCropOpen(false);
      toast(t`Saved`);
    } catch (e) {
      setError({ message: errMsg(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="disclosure fcard st-settings">
      <summary>
        <span className="fcard-ico">
          <Icon name="settings" size={18} />
        </span>
        <span className="fcard-text">
          <b>{t`Settings`}</b>
          <small className="fcard-sub">{settingsSummary(sensor)}</small>
        </span>
        <span className="fcard-flags">
          <span className="fcard-flag dirty" hidden={!dirty}>
            <i aria-hidden="true" />
            <Trans>Unsaved</Trans>
          </span>
        </span>
        <span className="fcard-chevron">
          <Icon name="down" size={18} />
        </span>
      </summary>
      <div className="fcard-body">
        <SettingRow title={t`Recognition`} desc={t`When off, labels and training results are kept; detection just pauses.`} toggle control={(a) => <Switch {...a} checked={draft.enabled} onChange={(enabled) => set({ enabled })} />} />
        <SettingRow title={t`Name`} wide control={(a) => <input {...a} type="text" autoComplete="off" spellCheck={false} maxLength={MAX_NAME} value={draft.name} onChange={(e) => set({ name: e.currentTarget.value })} />} />
        <div className="set-block">
          <p className="set-row-title">{t`Classes`}</p>
          <p className="set-row-desc st-cls-desc"><Trans>Renaming doesn’t need retraining; adding or deleting a class does.</Trans></p>
          <ClassesEditor rows={draft.rows} onRows={(rows) => set({ rows })} invalid={error?.index ?? null} counts={counts} />
        </div>
        <div className="set-block">
          <div className="st-crop-row">
            <div>
              <p className="set-row-title">{t`Detection area`}</p>
              <p className="set-row-desc"><Trans>After moving the area, the labeled pictures still show the old area. It’s best to pick new pictures and retrain.</Trans></p>
            </div>
            {cropOpen ? null : (
              <Button small icon="crosshair" iconSize={15} onClick={() => setCropOpen(true)}>
                <Trans>Adjust area</Trans>
              </Button>
            )}
          </div>
          {cropOpen ? <CropEditor cameraId={cam.id} value={draft.crop} onChange={(crop) => set({ crop })} /> : null}
        </div>
        <SettingRow
          title={t`How sure it must be`}
          desc={t`Stricter means fewer false detections, but it may take longer to settle in poor light.`}
          wide
          control={
            <Choice
              label={t`How sure it must be`}
              presets={THRESHOLD_PRESETS.map((p) => ({ value: p.value * 100, label: t(p.label) }))}
              initial={Math.round(draft.threshold * 100)}
              unit="%"
              onChange={(v) => set({ threshold: v / 100 })}
            />
          }
        />
        <SettingRow
          title={t`How often to check`}
          desc={t`With “On change only”, it checks only when the picture inside the area changes.`}
          wide
          control={
            <Choice
              label={t`How often to check`}
              presets={[
                { value: 5, label: t`5 sec` },
                { value: 10, label: t`10 sec` },
                { value: 60, label: t`1 min` },
                { value: 0, label: t`On change only` },
              ]}
              initial={draft.intervalSec}
              unit={t`sec`}
              onChange={(intervalSec) => set({ intervalSec })}
            />
          }
        />
        <SettingRow title={t`Check right away on change`} desc={t`Checks immediately when something moves in the area, so it switches faster.`} toggle control={(a) => <Switch {...a} checked={draft.onMotion} onChange={(onMotion) => set({ onMotion })} />} />
        <div className="set-block st-save">
          <p className="form-error" role="alert">
            {error?.message}
          </p>
          <Button disabled={!dirty || saving} onClick={() => (setDraft(base), setError(null), setCropOpen(false))}>
            <Trans>Revert</Trans>
          </Button>
          <Button variant="primary" disabled={!dirty || saving} aria-busy={saving || undefined} onClick={() => void save()}>
            {saving ? <span className="spin" aria-hidden="true" /> : null}
            <Trans>Save</Trans>
          </Button>
        </div>
      </div>
    </details>
  );
}

function settingsSummary(s: StateSensorDto): string {
  const c = s.config;
  const parts = [c.classes.join(" / ")];
  if (!c.enabled) parts.unshift(tc`Paused`);
  if (!c.intervalSec) parts.push(tc`Checks on change only`);
  else if (c.intervalSec >= 60 && c.intervalSec % 60 === 0) {
    const minutes = c.intervalSec / 60;
    parts.push(plural(minutes, { one: "Checks every # minute", other: "Checks every # minutes" }));
  } else {
    const seconds = c.intervalSec;
    parts.push(plural(seconds, { one: "Checks every # second", other: "Checks every # seconds" }));
  }
  return parts.join(" · ");
}

function Danger({ cam, sensor }: { cam: CameraDto; sensor: StateSensorDto }) {
  const { t } = useLingui();
  const sensorName = sensor.config.name;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const remove = async () => {
    const ok = await confirmDialog(t`Delete “${sensorName}”?`, t`Labeled pictures, training results and the change history will all be deleted. This can’t be undone.`, { confirmLabel: t`Delete`, danger: true });
    if (!ok) return;
    try {
      await api.deleteState(sensor.id);
      onSensorRemoved(qc, sensor.id);
      toast(t`Deleted “${sensorName}”`);
      void navigate({ to: "/settings/cameras/$id", params: { id: cam.id }, replace: true });
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <section className="danger-zone">
      <div className="danger-text">
        <b>{t`Delete this sensor`}</b>
        <p>{t`Labeled pictures and training results will be deleted too.`}</p>
      </div>
      <Button variant="danger" icon="trash" onClick={() => void remove()}>
        <Trans>Delete sensor</Trans>
      </Button>
    </section>
  );
}
