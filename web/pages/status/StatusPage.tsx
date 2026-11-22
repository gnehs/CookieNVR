import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { CameraDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { camerasQuery, metricsQuery, objectsQuery, settingsQuery, systemQuery } from "../../data/queries.ts";
import { useHealth } from "../../data/use-health.ts";
import { formatBytes, formatClock } from "../../format.ts";
import type { Issue } from "../../health.ts";
import { Button, ButtonLink, CopyButton } from "../../ui/Button.tsx";
import { confirmDialog } from "../../ui/Dialog.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Badge } from "../../ui/Panel.tsx";
import { ErrorBox, Spinner } from "../../ui/states.tsx";
import { toast } from "../../ui/toast.tsx";
import { SettingsLayout } from "../settings/SettingsLayout.tsx";
import { explain, SYSTEM_ICON, type Action, type Restart, type Snapshot } from "./explain.ts";
import { serverText } from "../../server-text.ts";
import { ResourcesCard } from "./ResourcesCard.tsx";

const POLL_MS = 5_000;
const byTone = (a: Issue, b: Issue) => (a.tone === b.tone ? 0 : a.tone === "bad" ? -1 : 1);

/** 攝影機快照縮圖；取不到（例如連不上）就用跟首頁一樣的佔位 */
function Thumb({ cameraId }: { cameraId: string }) {
  const [src] = useState(() => api.snapshotUrl(cameraId, Date.now()));
  const [loaded, setLoaded] = useState(false);
  return (
    <span className="issue-thumb">
      {loaded ? null : (
        <span className="cam-ph">
          <Icon name="camera" size={16} />
        </span>
      )}
      <img src={src} alt="" decoding="async" hidden={!loaded} onLoad={() => setLoaded(true)} />
    </span>
  );
}

function IssueAction({ action, onRestart }: { action: Action; onRestart: (a: Restart) => void }) {
  if ("restart" in action) {
    return (
      <Button small onClick={() => onRestart(action.restart)}>
        {action.label}
      </Button>
    );
  }
  const { label, ...link } = action;
  return (
    <ButtonLink small {...link}>
      {label}
    </ButtonLink>
  );
}

function IssueRow({ issue, snap, onRestart }: { issue: Issue; snap: Snapshot; onRestart: (a: Restart) => void }) {
  const { t } = useLingui();
  const e = explain(issue, snap);
  return (
    <article className="issue-row" data-tone={issue.tone} aria-label={issue.title}>
      <span className="issue-thumbs" aria-hidden="true">
        {issue.cameras.length ? (
          issue.cameras.slice(0, 3).map((c) => <Thumb key={c.id} cameraId={c.id} />)
        ) : (
          <span className="issue-thumb sys">
            <Icon name={SYSTEM_ICON[issue.kind] ?? "hdd"} size={18} />
          </span>
        )}
      </span>
      <div className="issue-main">
        <h3>
          <span className="issue-who">{e.who}</span>
          <Badge kind={e.pill.tone}>{e.pill.label}</Badge>
        </h3>
        <p className="issue-next">{e.next}</p>
        <details className="issue-why">
          <summary>{t`Possible causes`}</summary>
          <p>{e.why}</p>
        </details>
      </div>
      {e.action ? <IssueAction action={e.action} onRestart={onRestart} /> : null}
    </article>
  );
}

/** 物件辨識來不及處理的提醒（後端給的一般人看得懂的話）；辨識暫停時沿用上一次的結果 */
function useLoadWarning(enabled: boolean): string | null {
  const q = useQuery({ ...objectsQuery(false), enabled, refetchInterval: POLL_MS });
  const [warning, setWarning] = useState<string | null>(null);
  const data = q.data;
  useEffect(() => {
    if (!enabled || q.isError) setWarning(null);
    else if (data && !data.status.paused) setWarning(data.status.warning === null ? null : serverText(data.status.warningMsg, data.status.warning));
  }, [enabled, q.isError, data]);
  return enabled ? warning : null;
}

/** 設定 → 狀態 */
export function StatusPage() {
  const { t } = useLingui();
  const qc = useQueryClient();
  const health = useHealth(true);
  const sys = useQuery(systemQuery);
  const settings = useQuery(settingsQuery);
  const cams = useQuery(camerasQuery);

  // 系統資源只在這一頁每 5 秒抓（watch=1 讓後端讀 GPU 與各程序）；結果同時寫進共用的 ["system","metrics"]，健康判斷（useHealth）讀同一份
  const metrics = useQuery({ ...metricsQuery(true), refetchInterval: POLL_MS });
  useEffect(() => {
    if (metrics.data) qc.setQueryData(metricsQuery().queryKey, metrics.data);
  }, [qc, metrics.data]);

  const loadWarning = useLoadWarning(settings.data?.objects.enabled ?? false);

  const restart = useMutation({
    mutationFn: async (r: { ids: string[]; done: string }) => {
      for (const id of r.ids) await api.restartWorker(id);
      return r.done;
    },
    onSuccess: async (done) => {
      toast(done);
      void qc.invalidateQueries({ queryKey: systemQuery.queryKey });
    },
  });
  const onRestart = async (r: Restart) => {
    if (await confirmDialog(r.title, r.message, { confirmLabel: t`Continue` })) restart.mutate(r);
  };

  const failed = [sys, settings, cams].find((q) => q.isError);
  const list = cams.data;
  const view = useMemo(() => {
    if (!health || !list) return null;
    // 辨識程序已經停止時，說的是更根本的問題，不重複提醒負載
    const extra: Issue[] = loadWarning && !health.issues.some((i) => i.kind === "objects") ? [{ kind: "objectsLoad", tone: "warn", cameras: [], title: loadWarning, short: t`Object detection can't keep up` }] : [];
    return { issues: [...health.issues, ...extra].sort(byTone) };
  }, [health, list, loadWarning, t]);

  return (
    <SettingsLayout active="status">
      {failed ? (
        <ErrorBox error={failed.error} onRetry={() => void failed.refetch()} />
      ) : !health || !view || !list ? (
        <Spinner />
      ) : (
        <Body issues={view.issues} snap={{ health, metrics: metrics.data ?? null }} cams={list} at={metrics.dataUpdatedAt || sys.dataUpdatedAt} onRestart={(r) => void onRestart(r)} />
      )}
    </SettingsLayout>
  );
}

function Body({ issues, snap, cams, at, onRestart }: { issues: Issue[]; snap: Snapshot; cams: CameraDto[]; at: number; onRestart: (a: Restart) => void }) {
  const { t } = useLingui();
  const hl = snap.health;
  // 問題已經在上面的卡片說過，下面只列沒事的攝影機
  const fine = cams.filter((c) => !hl.statuses.get(c.id)!.problem);
  const n = issues.length;
  const active = cams.filter((c) => c.config.enabled).length;
  const recording = fine.filter((c) => hl.statuses.get(c.id)!.kind === "recording").length;
  const tone = n === 0 ? "ok" : issues.some((i) => i.tone === "bad") ? "bad" : "warn";
  const d = hl.disk;
  const total = formatBytes(d.total);
  const usedPct = d.usedPct.toFixed(0);
  const dataFree = formatBytes(hl.dataDisk?.free ?? 0);
  const dataTotal = formatBytes(hl.dataDisk?.total ?? 0);
  const updatedAt = formatClock(at);
  return (
    <div className="stack">
      <section className="card health" data-tone={tone} aria-label={t`Overall status`}>
        <header className="health-head">
          <i className="health-dot" aria-hidden="true" />
          <h2>{n === 0 ? t`Everything is fine` : plural(n, { one: "# thing needs attention", other: "# things need attention" })}</h2>
          {n === 0 ? (
            <p>
              {active === 0
                ? t`No cameras are enabled yet.`
                : recording === active
                  ? plural(active, { one: "# camera is recording.", other: "All # cameras are recording." })
                  : plural(active, { one: "# camera is connected.", other: "All # cameras are connected." })}
            </p>
          ) : null}
        </header>
        {n ? (
          <div className="issue-list" aria-live="polite">
            {issues.map((i) => (
              <IssueRow key={`${i.kind}:${i.cameras.map((c) => c.id).join(",")}`} issue={i} snap={snap} onRestart={onRestart} />
            ))}
          </div>
        ) : null}
      </section>

      <section className="card" hidden={cams.length > 0 && fine.length === 0}>
        <h2 className="card-title">{n > 0 ? t`Other cameras` : t`Cameras`}</h2>
        <div className="status-list">
          {cams.length ? (
            fine.map((c) => {
              const st = hl.statuses.get(c.id)!;
              return (
                <div className="status-row" key={c.id}>
                  <b title={c.config.name}>{c.config.name}</b>
                  <Badge kind={st.tone}>{st.label}</Badge>
                </div>
              );
            })
          ) : (
            <div className="state bare">
              <p>{t`No cameras yet.`}</p>
              <ButtonLink to="/settings/cameras/new" small icon="plus" iconSize={15}>
                {t`Add camera`}
              </ButtonLink>
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">{t`Storage`}</h2>
        <div className="card-body">
          <div className="disk">
            <div className="disk-big">
              <b>{formatBytes(d.free)}</b>
              <span className="muted">{t`available, ${total} total`}</span>
            </div>
            <div className={`bar${d.tone === "bad" ? " bad" : d.tone === "warn" ? " warn" : ""}`} role="img" aria-label={t`${usedPct}% used`}>
              <i style={{ width: `${d.usedPct.toFixed(1)}%` }} />
            </div>
            <div className="disk-nums">
              <span className="num">{hl.dataDisk ? t`Recording disk ${usedPct}% used` : t`${usedPct}% used`}</span>
              <Link to="/settings/storage">{t`Manage storage`}</Link>
            </div>
            {hl.dataDisk ? (
              <p className="disk-sub num" data-tone={hl.dataDisk.tone}>{t`appdata disk: ${dataFree} free, ${dataTotal} total`}</p>
            ) : null}
          </div>
        </div>
      </section>

      {snap.metrics ? <ResourcesCard metrics={snap.metrics} cams={cams} /> : null}

      <footer className="status-foot">
        <span>{t`If something goes wrong, copy the diagnostics and paste them to an AI or a technician. Passwords and similar data are masked automatically.`}</span>
        <div className="form-actions">
          <span className="num">{t`Refreshes every 5 seconds · last at ${updatedAt}`}</span>
          <CopyButton label={t`Copy diagnostics`} className="small" getText={() => api.diagnostics()} done={t`Diagnostics copied. You can paste them to an AI or a technician.`} />
        </div>
      </footer>
    </div>
  );
}
