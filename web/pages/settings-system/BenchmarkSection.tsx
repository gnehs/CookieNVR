import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { BenchmarkDto, ObjectsDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { benchmarkView, BENCHMARK_ASSUMPTION, BENCHMARK_RUNNING_NOTE, endedText, progressOf } from "../../detect/benchmark-model.ts";
import { deviceLabel } from "../../detect/object-model.ts";
import { formatDateTime } from "../../format.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { SettingRow } from "../../ui/SettingRow.tsx";
import { objectsQuery } from "../../data/queries.ts";

export const isBenchmarking = (data: ObjectsDto | undefined): boolean => data?.benchmark?.state === "running" || data?.status.paused === "benchmark";

function Result({ b, data }: { b: BenchmarkDto; data: ObjectsDto }) {
  const view = benchmarkView(b, { currentDevice: data.status.device?.id ?? null, models: data.models, formatTime: formatDateTime });
  const ended = endedText(b);
  const details = view.rows.filter((r) => r.detail);
  return (
    <div className="set-block obj-block bench-result">
      {ended ? (
        <p className={`callout ${ended.tone}`}>
          <Icon name="alert" />
          <span>{ended.text}</span>
        </p>
      ) : null}
      {view.stale ? (
        <p className="callout warn">
          <Icon name="alert" />
          <span>結果可能已過期（換了模型或裝置），建議重新測速。</span>
        </p>
      ) : null}
      {view.headline ? (
        <p className="bench-headline" data-tone={view.headline.tone}>
          <Icon name={view.headline.tone === "ok" ? "check-circle" : "alert-circle"} size={18} />
          <b>{view.headline.text}</b>
        </p>
      ) : null}
      {view.verdict ? (
        <p className="bench-verdict" data-tone={view.verdict.tone}>
          {view.verdict.text}
        </p>
      ) : null}
      {view.rows.length > 1 ? (
        <ul className="bench-rows" aria-label="各裝置的測速結果">
          {view.rows.map((r) => (
            <li key={r.device} data-tone={r.tone}>
              <span className="bench-name">
                {r.name}
                {r.current ? <span className="bench-tag">使用中</span> : null}
                {r.best ? <span className="bench-tag best">最快</span> : null}
              </span>
              <span className="bench-val num">{r.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {details.length ? (
        <details className="detect-more obj-details">
          <summary>
            <Icon name="chevron" size={15} />
            詳細數字
          </summary>
          <dl className="bench-detail">
            {details.map((r) => (
              <div key={r.device} style={{ display: "contents" }}>
                <dt>{r.name}</dt>
                <dd className="num">{r.detail}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      {b.results.length > 0 ? (
        <>
          <small className="hint">{view.meta}</small>
          <small className="hint">{BENCHMARK_ASSUMPTION}</small>
        </>
      ) : null}
    </div>
  );
}

/** 「測速」：量這台機器大約能同時處理幾台攝影機。多個裝置時可以勾選要測哪些 */
export function BenchmarkSection({ data }: { data: ObjectsDto | undefined }) {
  const qc = useQueryClient();
  // null = 還沒動過勾選，預設選目前使用的裝置
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const devices = data?.devices ?? [];
  const active = data?.status.device?.id ?? null;
  const fallback = (devices.find((d) => d.id === active) ?? devices[0])?.id;
  const selected = picked ? new Set([...picked].filter((id) => devices.some((d) => d.id === id))) : new Set(fallback ? [fallback] : []);
  const running = isBenchmarking(data);
  const multi = devices.length > 1;

  const start = useMutation({
    mutationFn: () => api.startBenchmark(multi ? [...selected] : undefined),
    onSuccess: (benchmark) => {
      qc.setQueryData(objectsQuery(true).queryKey, (d: ObjectsDto | undefined) => (d ? { ...d, benchmark } : d));
      return qc.invalidateQueries({ queryKey: ["objects"] });
    },
  });
  const cancel = useMutation({ mutationFn: api.cancelBenchmark, onSettled: () => qc.invalidateQueries({ queryKey: ["objects"] }) });

  const ready = data?.status.state === "ready";
  const none = multi && selected.size === 0;
  const hint = running || (ready && !none) ? null : !ready ? "物件辨識準備好之後才能測速。" : "請至少選一個裝置。";

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  const all = devices.length > 0 && devices.every((d) => selected.has(d.id));

  const b = data?.benchmark;
  const progress = b && b.state === "running" ? progressOf(b, devices) : { text: "準備中…", fraction: 0 };
  const pct = Math.round(progress.fraction * 100);

  return (
    <div className="set-rows" role="group" aria-label="測速">
      <SettingRow
        title="測速"
        desc={
          <>
            測一下這台機器大約可以同時處理幾台攝影機。
            {hint ? (
              <small className="hint">
                {hint}
              </small>
            ) : null}
          </>
        }
        control={
          running ? (
            <Button disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              取消
            </Button>
          ) : (
            <Button icon="activity" disabled={start.isPending || !ready || none} onClick={() => start.mutate()}>
              測速
            </Button>
          )
        }
      />
      {multi && !running ? (
        <div className="set-block obj-block">
          <div className="obj-bench-pickhead">
            <span className="set-row-title">要測哪些裝置</span>
            <Button variant="ghost" small onClick={() => setPicked(all ? new Set(fallback ? [fallback] : []) : new Set(devices.map((d) => d.id)))}>
              {all ? "只測目前使用的" : "全部都測"}
            </Button>
          </div>
          <div className="obj-labels" role="group" aria-label="要測哪些裝置">
            {devices.map((d) => (
              <label className="obj-label" key={d.id}>
                <input type="checkbox" value={d.id} checked={selected.has(d.id)} onChange={(e) => toggle(d.id, e.currentTarget.checked)} />
                <span>
                  <Icon name="check" size={15} />
                  {deviceLabel(d)}
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
      {running ? (
        <div className="set-block obj-block bench-progress" role="status" aria-live="polite">
          <div className="bench-progress-head">
            <span className="spin" />
            <b className="num">{progress.text}</b>
          </div>
          <div className="bar" role="progressbar" aria-label="測速進度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <small className="hint">{BENCHMARK_RUNNING_NOTE}</small>
        </div>
      ) : null}
      {b && b.state !== "running" && !running && data ? <Result b={b} data={data} /> : null}
    </div>
  );
}
