import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import type { StateJobDto, StateSensorDto } from "../../src/api-types.ts";
import { sensorView, sinceText, stateText, viewTone } from "./model.ts";

/** 「12 分鐘前」這類文字要跟著時間走；每 30 秒重畫一次 */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** 感應器目前的狀態：一個色點加一行字，例如「開 · 12 分鐘前」「確認中：關」「還沒訓練」 */
export function StateLine({ sensor, now, withName = false }: { sensor: StateSensorDto; now: number; withName?: boolean }) {
  const { t } = useLingui();
  const v = sensorView(sensor);
  const sensorName = sensor.config.name;
  const candidate = v.kind === "state" ? v.candidate : null;
  const name = withName ? <b className="st-name">{t`${sensorName}:`}</b> : null;
  return (
    <span className="st-line" data-tone={viewTone(v)} data-kind={v.kind}>
      <i className="st-dot" aria-hidden="true" />
      {v.kind === "state" ? (
        <span className="st-text">
          {name}
          <b className="st-value">{v.label}</b>
          <span className="st-since"> · {sinceText(v.since, now)}</span>
          {candidate ? <span className="st-candidate">{t`, may change to “${candidate}”`}</span> : null}
        </span>
      ) : (
        <span className="st-text">
          {name}
          {stateText(v, now)}
        </span>
      )}
    </span>
  );
}

const JOB_TEXT: Record<StateJobDto["kind"], { running: MessageDescriptor; queued: MessageDescriptor }> = {
  collect: { running: msg`Picking frames from recordings…`, queued: msg`Picking frames from recordings, waiting for other sensors to finish…` },
  import: { running: msg`Importing training data…`, queued: msg`Importing training data, waiting for other sensors to finish…` },
  train: { running: msg`Training…`, queued: msg`Training, waiting for other sensors to finish…` },
};

/** 進行中的背景工作：一句話加進度條（不知道進度時是來回跑的條） */
export function JobBar({ job }: { job: Extract<StateJobDto, { state: "queued" | "running" }> }) {
  const { i18n } = useLingui();
  const p = job.state === "running" ? job.progress : null;
  return (
    <div className="st-job" role="status">
      <div className="st-job-text">
        <span className="spin" aria-hidden="true" />
        <span>{i18n._(JOB_TEXT[job.kind][job.state])}</span>
        {p !== null ? <b className="num">{Math.round(p * 100)}%</b> : null}
      </div>
      <div className={`st-progress${p === null ? " indeterminate" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p === null ? undefined : Math.round(p * 100)}>
        <i style={p === null ? undefined : { width: `${(p * 100).toFixed(1)}%` }} />
      </div>
    </div>
  );
}
