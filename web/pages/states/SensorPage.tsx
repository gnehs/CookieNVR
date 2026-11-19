import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { CameraDto, CropBox, StateSensorDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { camerasQuery } from "../../data/queries.ts";
import { errMsg, formatDateTime } from "../../format.ts";
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
  const sensors = useQuery(statesQuery);
  const cams = useQuery(camerasQuery);
  // 刪除後快取裡已經沒有它，但還沒換頁；別閃一下「找不到」
  const last = useRef<StateSensorDto | null>(null);
  if (sensors.isPending || cams.isPending) return <Spinner />;
  const failed = sensors.isError ? sensors : cams.isError ? cams : null;
  if (failed) return <ErrorBox error={failed.error} onRetry={() => void failed.refetch()} />;
  const cam = cams.data!.find((c) => c.id === cameraId);
  const sensor = sensors.data!.find((s) => s.id === sensorId && s.cameraId === cameraId) ?? (last.current?.id === sensorId ? last.current : null);
  if (!cam || !sensor) return <ErrorBox error={new PageError("找不到這個感應器", "它可能已經被刪除了。", { label: "回到攝影機設定", to: cam ? `/settings/cameras/${cam.id}` : "/settings/cameras" })} />;
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
  const now = useNow();
  const v = sensorView(sensor);
  const job = sensor.job;
  const recentJob = job && (job.state === "done" || job.state === "failed") && job.kind !== "train" && now - job.finishedAt < 15 * 60_000 ? job : null;
  return (
    <section className="card st-hero" aria-label="目前狀態">
      <div className="st-hero-main">
        <span className="hint">{cam.config.name}</span>
        {v.kind === "state" ? (
          <>
            <p className="st-big">{v.label}</p>
            <p className="st-hero-sub" title={formatDateTime(v.since)}>
              {sinceText(v.since, now)}切換{v.candidate ? `・正在確認是不是變成「${v.candidate}」` : ""}
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
          <span>{recentJob.message}</span>
        </p>
      ) : recentJob?.state === "failed" ? (
        <p className="callout bad">
          <Icon name="alert" size={16} />
          <span>{recentJob.error}</span>
        </p>
      ) : null}
    </section>
  );
}

function heroHint(s: StateSensorDto): string {
  const v = sensorView(s);
  if (v.kind === "confirming") return "連續幾次看到同一個樣子就會確定，通常幾十秒內。";
  if (v.kind === "paused") return s.problem?.code === "disabled" ? "到下面的設定打開「辨識」就會繼續。" : "等畫面穩定下來就會繼續。";
  if (v.kind !== "problem") return "";
  switch (v.code) {
    case "untrained":
      return s.trainable ? "每一類都有畫面了，按「開始訓練」。" : "在下面標記畫面，每一類都有了就能訓練。";
    case "stale-model":
      return "類別改過了，重新訓練後才會繼續辨識。";
    case "camera-off":
      return "攝影機沒有畫面，等它連上就會繼續。";
    case "worker":
      return v.message;
  }
}

/** 訓練：每類的張數、還差幾張、開始訓練與進度，完成後用白話說結果 */
function TrainCard({ cam, sensor }: { cam: CameraDto; sensor: StateSensorDto }) {
  const qc = useQueryClient();
  const [starting, setStarting] = useState(false);
  const status = trainStatus(sensor);
  const job = sensor.job;
  const training = job?.kind === "train" && (job.state === "queued" || job.state === "running") ? job : null;
  const failed = job?.kind === "train" && job.state === "failed" ? job : null;
  const needs = needsText(sensor);
  const m = sensor.model;
  const result = m ? resultSummary(m) : null;
  const busy = jobActive(sensor) || starting;
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
          {m ? "辨識的準確度" : "訓練"}
        </h2>
        <Button variant={primary ? "primary" : undefined} small={!primary} icon="refresh" iconSize={15} disabled={busy || !sensor.trainable} onClick={() => void train()}>
          {m ? "重新訓練" : "開始訓練"}
        </Button>
      </header>
      <div className="st-counts" role="list" aria-label="每一類標記了幾張">
        {sensor.images.labeled.map((l) => (
          <span key={l.label} role="listitem" className="st-count" data-short={l.count < 2 ? "" : undefined}>
            <b>{l.label}</b>
            <span className="num">{l.count} 張</span>
          </span>
        ))}
      </div>
      {training ? <JobBar job={training} /> : null}
      {!training && needs ? <p className="hint st-needs">{needs}。在下面把待標記的畫面分好類。</p> : null}
      {!training && !needs && status === "stale" ? (
        <p className="callout warn">
          <Icon name="alert" size={16} />
          <span>類別改過了，重新訓練後才會繼續辨識。</span>
        </p>
      ) : null}
      {!training && !needs && status === "outdated" ? <p className="hint">標記跟上次訓練時不一樣了，重新訓練就會用上新的標記。</p> : null}
      {!training && !needs && status === "untrained" ? <p className="hint">每一類都有畫面了。訓練只要幾秒到幾十秒，完成後馬上開始辨識。</p> : null}
      {failed && !training ? (
        <p className="callout bad">
          <Icon name="alert" size={16} />
          <span>訓練失敗：{failed.error}</span>
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
            <summary>詳細資料</summary>
            <div className="st-detail">
              {result.mistakes.length ? (
                <ul>
                  {result.mistakes.map((x) => (
                    <li key={`${x.actual}>${x.predicted}`}>
                      {x.count} 張「{x.actual}」被看成「{x.predicted}」
                    </li>
                  ))}
                </ul>
              ) : (
                <p>驗證時沒有看錯的畫面。</p>
              )}
              <p className="hint">
                驗證的畫面都沒有拿來學，跟實際使用時一樣是第一次看到。{formatDateTime(m.trainedAt)} 訓練，用了 {m.counts.reduce((n, c) => n + c.count, 0)} 張。看錯的多半是光線不同或過渡中的畫面，多標幾張類似的再重新訓練就會改善。
              </p>
              <CopyButton label="複製診斷資訊" className="small" getText={() => api.diagnostics(cam.id)} done="已複製診斷資訊，可以貼給 AI 或技術人員" />
            </div>
          </details>
        </div>
      ) : null}
    </section>
  );
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
        最近的變化
      </h2>
      {q.isPending ? (
        <p className="hint st-pad">
          <span className="spin" aria-hidden="true" /> 讀取中…
        </p>
      ) : list.length === 0 ? (
        <p className="hint st-pad">還沒有變化過。狀態改變時會記在這裡。</p>
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
            顯示更多
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
    if (!Number.isFinite(draft.threshold) || draft.threshold < 0.5 || draft.threshold > 0.99) return setError({ message: "把握程度要在 50% 到 99% 之間" });
    if (!Number.isInteger(draft.intervalSec) || draft.intervalSec < 0 || draft.intervalSec > 3600) return setError({ message: "間隔要是 0 到 3600 秒的整數" });
    const original = sensor.config.classes;
    const plan = planClassEdit(original, draft.rows);
    const lost = plan.removed.reduce((sum, r) => sum + (counts.get(r) ?? 0), 0);
    const added = draft.rows.some((r) => r.original === null);
    if (plan.removed.length && !(await confirmDialog(`刪除「${plan.removed.join("、")}」？`, lost ? `已標記成這${plan.removed.length > 1 ? "些" : ""}類的 ${lost} 張畫面會退回待標記，之後要重新訓練才會繼續辨識。` : "刪除類別後要重新訓練才會繼續辨識。", { confirmLabel: "刪除並儲存", danger: true }))) return;
    if (!plan.removed.length && added && sensor.model && !(await confirmDialog("新增類別？", "新增類別後要標記這一類的畫面並重新訓練，在那之前會暫停辨識。", { confirmLabel: "儲存" }))) return;
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
      toast("已儲存");
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
          <b>設定</b>
          <small className="fcard-sub">{settingsSummary(sensor)}</small>
        </span>
        <span className="fcard-flags">
          <span className="fcard-flag dirty" hidden={!dirty}>
            <i aria-hidden="true" />
            未儲存
          </span>
        </span>
        <span className="fcard-chevron">
          <Icon name="down" size={18} />
        </span>
      </summary>
      <div className="fcard-body">
        <SettingRow title="辨識" desc="關掉時保留標記與訓練結果，只是暫停判斷。" toggle control={(a) => <Switch {...a} checked={draft.enabled} onChange={(enabled) => set({ enabled })} />} />
        <SettingRow title="名稱" wide control={(a) => <input {...a} type="text" autoComplete="off" spellCheck={false} maxLength={MAX_NAME} value={draft.name} onChange={(e) => set({ name: e.currentTarget.value })} />} />
        <div className="set-block">
          <p className="set-row-title">類別</p>
          <p className="set-row-desc st-cls-desc">改名不用重新訓練；新增或刪除類別後要重新訓練。</p>
          <ClassesEditor rows={draft.rows} onRows={(rows) => set({ rows })} invalid={error?.index ?? null} counts={counts} />
        </div>
        <div className="set-block">
          <div className="st-crop-row">
            <div>
              <p className="set-row-title">辨識區域</p>
              <p className="set-row-desc">移動區域後，原本標記的畫面仍然是舊區域的樣子，最好重新挑選畫面再訓練。</p>
            </div>
            {cropOpen ? null : (
              <Button small icon="crosshair" iconSize={15} onClick={() => setCropOpen(true)}>
                調整區域
              </Button>
            )}
          </div>
          {cropOpen ? <CropEditor cameraId={cam.id} value={draft.crop} onChange={(crop) => set({ crop })} /> : null}
        </div>
        <SettingRow
          title="要多有把握才算數"
          desc="越嚴格越不會誤判，但光線不好時可能比較慢才確定。"
          wide
          control={
            <Choice
              label="要多有把握才算數"
              presets={THRESHOLD_PRESETS.map((p) => ({ value: p.value * 100, label: p.label }))}
              initial={Math.round(draft.threshold * 100)}
              unit="%"
              onChange={(v) => set({ threshold: v / 100 })}
            />
          }
        />
        <SettingRow
          title="多久看一次"
          desc="選「不定時」時只在區域內畫面有變化時看。"
          wide
          control={
            <Choice
              label="多久看一次"
              presets={[
                { value: 5, label: "5 秒" },
                { value: 10, label: "10 秒" },
                { value: 60, label: "1 分鐘" },
                { value: 0, label: "不定時" },
              ]}
              initial={draft.intervalSec}
              unit="秒"
              onChange={(intervalSec) => set({ intervalSec })}
            />
          }
        />
        <SettingRow title="畫面有變化時馬上看" desc="區域裡有動靜時立刻判斷一次，切換得更快。" toggle control={(a) => <Switch {...a} checked={draft.onMotion} onChange={(onMotion) => set({ onMotion })} />} />
        <div className="set-block st-save">
          <p className="form-error" role="alert">
            {error?.message}
          </p>
          <Button disabled={!dirty || saving} onClick={() => (setDraft(base), setError(null), setCropOpen(false))}>
            還原
          </Button>
          <Button variant="primary" disabled={!dirty || saving} aria-busy={saving || undefined} onClick={() => void save()}>
            {saving ? <span className="spin" aria-hidden="true" /> : null}
            儲存
          </Button>
        </div>
      </div>
    </details>
  );
}

function settingsSummary(s: StateSensorDto): string {
  const c = s.config;
  const parts = [c.classes.join("／")];
  if (!c.enabled) parts.unshift("已暫停");
  parts.push(c.intervalSec ? `每 ${c.intervalSec >= 60 && c.intervalSec % 60 === 0 ? `${c.intervalSec / 60} 分鐘` : `${c.intervalSec} 秒`}看一次` : "有變化時才看");
  return parts.join("・");
}

function Danger({ cam, sensor }: { cam: CameraDto; sensor: StateSensorDto }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const remove = async () => {
    const ok = await confirmDialog(`刪除「${sensor.config.name}」？`, "標記的畫面、訓練結果與變化紀錄都會一起刪除，無法復原。", { confirmLabel: "刪除", danger: true });
    if (!ok) return;
    try {
      await api.deleteState(sensor.id);
      onSensorRemoved(qc, sensor.id);
      toast(`已刪除「${sensor.config.name}」`);
      void navigate({ to: "/settings/cameras/$id", params: { id: cam.id }, replace: true });
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <section className="danger-zone">
      <div className="danger-text">
        <b>刪除這個感應器</b>
        <p>標記的畫面與訓練結果會一起刪除。</p>
      </div>
      <Button variant="danger" icon="trash" onClick={() => void remove()}>
        刪除感應器
      </Button>
    </section>
  );
}
