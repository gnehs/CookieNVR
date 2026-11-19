import { useState } from "react";
import type { CameraDto, GpuDto, MetricsDto, MetricsPointDto, UsageCategory } from "../../../src/api-types.ts";
import { formatBytes } from "../../format.ts";
import { Segmented } from "../../ui/controls.tsx";

/** 「資源花在哪裡」的類別名稱；資源警告也用它說明誰用最多 */
export const CATEGORY_LABEL: Record<UsageCategory, string> = {
  record: "錄影",
  detect: "動作偵測",
  detector: "物件辨識",
  live: "即時觀看",
  restream: "影像服務",
  homekit: "Apple 家庭",
  export: "匯出影片",
  system: "系統本身",
};

/** 量表變黃的門檻；跟首頁提醒的門檻（health.ts 的 PRESSURE）一樣，但這裡看的是當下 */
const HIGH_PCT = 90;
const WINDOW_MS = 10 * 60_000;

type Mode = "cpu" | "memory";
type Series = { at: number; v: number | null }[];

interface TileData {
  key: string;
  label: string;
  /** 大數字，例如「23%」；讀不到時是「—」 */
  value: string;
  sub: string;
  pct: number | null;
  series: Series;
  now: number;
  extras?: string[];
}

const pctText = (v: number | null) => (v === null ? "—" : `${Math.round(v)}%`);

/** 一小段近期走勢：時間軸固定 10 分鐘，缺的取樣留白，不連線 */
function sparkPath(series: Series, now: number): { line: string; area: string } {
  const x = (at: number) => (100 - ((now - at) / WINDOW_MS) * 100).toFixed(2);
  const y = (v: number) => (27 - (Math.min(100, Math.max(0, v)) / 100) * 25).toFixed(2);
  let line = "";
  let area = "";
  let run: { at: number; v: number }[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const pts = run.length === 1 ? [run[0]!, { at: run[0]!.at + 5_000, v: run[0]!.v }] : run;
    const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.at)} ${y(p.v)}`).join("");
    line += d;
    area += `${d}L${x(pts.at(-1)!.at)} 28L${x(pts[0]!.at)} 28Z`;
    run = [];
  };
  for (const p of series) {
    if (p.at < now - WINDOW_MS) continue;
    if (p.v === null) flush();
    else run.push({ at: p.at, v: p.v });
  }
  flush();
  return { line, area };
}

function trendText(label: string, series: Series): string {
  const v = series.map((p) => p.v).filter((n): n is number => n !== null);
  if (v.length < 2) return `${label}的近期走勢：還在收集`;
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  return `${label}最近 10 分鐘：平均 ${Math.round(avg)}%，最高 ${Math.round(Math.max(...v))}%`;
}

function Tile({ d }: { d: TileData }) {
  const p = d.pct === null ? 0 : Math.min(100, Math.max(0, d.pct));
  const path = sparkPath(d.series, d.now);
  return (
    <div className="res-tile" role="group" aria-label={d.label} data-tone={d.pct !== null && d.pct >= HIGH_PCT ? "warn" : ""}>
      <div className="res-head">
        <span className="res-label" title={d.label}>
          {d.label}
        </span>
        <b className="res-value num">{d.value}</b>
      </div>
      <div className="res-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-label={`${d.label}使用率`} aria-valuenow={Math.round(p)} aria-valuetext={d.value} hidden={d.pct === null}>
        <i style={{ transform: `scaleX(${p / 100})` }} />
      </div>
      <svg className="res-spark" viewBox="0 0 100 28" preserveAspectRatio="none" role="img" aria-label={trendText(d.label, d.series)}>
        <path className="res-spark-area" d={path.area} />
        <path className="res-spark-line" d={path.line} vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="res-sub num">{d.sub}</span>
      <ul className="res-extras" hidden={!d.extras?.length}>
        {d.extras?.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

function Row({ label, share, text, muted }: { label: string; share: number; text: string; muted?: boolean }) {
  return (
    <div className={`res-row${muted ? " muted-row" : ""}`}>
      <span className="res-row-name" title={label}>
        {label}
      </span>
      <div className="res-row-bar" aria-hidden="true">
        <i style={{ transform: `scaleX(${Math.min(1, Math.max(0, share))})` }} />
      </div>
      <span className="num">{text}</span>
    </div>
  );
}

function gpuTile(g: GpuDto, history: MetricsPointDto[], now: number): TileData {
  const parts: string[] = [];
  if (g.memory) parts.push(`顯示記憶體 ${formatBytes(g.memory.usedBytes)} / ${formatBytes(g.memory.totalBytes)}`);
  if (g.temperatureC !== null) parts.push(`${g.temperatureC}°C`);
  if (g.note) parts.push(g.note);
  if (!parts.length) parts.push(g.utilPct === null ? "使用率無法取得" : g.memory === null ? "與系統共用記憶體" : "使用率");
  return {
    key: g.id,
    // 卡片很窄，「NVIDIA GeForce RTX 3060」留型號就好；完整名稱在 title
    label: g.name.replace(/^NVIDIA\s+(?=\S)/, ""),
    value: pctText(g.utilPct),
    pct: g.utilPct,
    sub: parts.join("・"),
    series: history.map((p) => ({ at: p.at, v: g.id in p.gpus ? (p.gpus[g.id] ?? null) : null })),
    now,
    extras: g.extras.map((e) => `${e.label}：${e.value}`),
  };
}

function tilesOf(m: MetricsDto): TileData[] {
  const now = m.at;
  const memPct = m.memory.totalBytes ? (m.memory.usedBytes / m.memory.totalBytes) * 100 : null;
  const limited = (scope: string) => scope === "container";
  const cpuCores = Number.isInteger(m.cpu.cores) ? m.cpu.cores : m.cpu.cores.toFixed(1);
  return [
    {
      key: "cpu",
      label: "處理器",
      value: pctText(m.cpu.pct),
      pct: m.cpu.pct,
      sub: limited(m.cpu.scope) ? `上限 ${cpuCores} 核心` : `共 ${cpuCores} 核心`,
      series: m.history.map((p) => ({ at: p.at, v: p.cpuPct })),
      now,
    },
    {
      key: "memory",
      label: "記憶體",
      value: pctText(memPct),
      pct: memPct,
      sub: `${formatBytes(m.memory.usedBytes)} / ${limited(m.memory.scope) ? "上限 " : ""}${formatBytes(m.memory.totalBytes)}`,
      series: m.history.map((p) => ({ at: p.at, v: p.memPct })),
      now,
    },
    ...m.gpus.map((g) => gpuTile(g, m.history, now)),
  ];
}

function Usage({ m, cams }: { m: MetricsDto; cams: CameraDto[] }) {
  const [mode, setMode] = useState<Mode>("cpu");
  const value = (u: { cpuPct: number; memBytes: number }) => (mode === "cpu" ? u.cpuPct : u.memBytes);
  const text = (v: number) => (mode === "cpu" ? (v > 0 && v < 1 ? "<1%" : `${Math.round(v)}%`) : formatBytes(v));

  let hint: string;
  let entries: { key: string; label: string; v: number; muted: boolean }[] = [];
  let camEntries: { key: string; label: string; v: number }[] = [];
  if (!m.usage) {
    hint = "正在計算…";
  } else {
    hint = mode === "cpu" ? `以${m.cpu.scope === "container" ? "可用的" : "整台機器的"}處理器為 100%` : "各項工作占用的記憶體";
    const list = m.usage.filter((u) => value(u) > 0 && (mode === "memory" || u.cpuPct >= 0.05));
    const otherLabel = m.memory.scope === "host" || m.cpu.scope === "host" ? (mode === "cpu" ? "其他程式" : "其他程式與快取") : "其他";
    entries = list.map((u) => ({ key: u.category as string, label: CATEGORY_LABEL[u.category], v: value(u), muted: false }));
    if (m.other && value(m.other) > 0) entries.push({ key: "other", label: otherLabel, v: value(m.other), muted: true });
    const perCam = new Map<string, number>();
    for (const u of m.usage) for (const c of u.cameras) perCam.set(c.cameraId, (perCam.get(c.cameraId) ?? 0) + value(c));
    camEntries = cams.filter((c) => perCam.has(c.id)).map((c) => ({ key: c.id, label: c.config.name, v: perCam.get(c.id)! }));
  }
  const max = Math.max(1e-9, ...entries.map((e) => e.v));
  const camMax = Math.max(1e-9, ...camEntries.map((e) => e.v));

  return (
    <div className="res-usage">
      <div className="res-usage-head">
        <h3>資源花在哪裡</h3>
        <Segmented
          label="用量依"
          options={[
            { value: "cpu", label: "處理器" },
            { value: "memory", label: "記憶體" },
          ]}
          value={mode}
          onChange={setMode}
        />
      </div>
      <p className="res-note">{hint}</p>
      <div className="res-rows">
        {entries.map((e) => (
          <Row key={e.key} label={e.label} share={e.v / max} text={text(e.v)} muted={e.muted} />
        ))}
      </div>
      <details className="more res-cams" hidden={camEntries.length === 0}>
        <summary>依攝影機查看</summary>
        <div className="res-rows">
          {camEntries.map((e) => (
            <Row key={e.key} label={e.label} share={e.v / camMax} text={text(e.v)} />
          ))}
        </div>
        <p className="res-note">影像服務、Apple 家庭與系統本身由所有攝影機共用，沒有算在個別攝影機裡。</p>
      </details>
    </div>
  );
}

/** 狀態頁的「系統資源」卡：CPU、記憶體、每張 GPU 一格，下面是依類別的用量 */
export function ResourcesCard({ metrics, cams }: { metrics: MetricsDto; cams: CameraDto[] }) {
  const tiles = tilesOf(metrics);
  const gpuNote = metrics.gpus.length > 0 || metrics.gpuMissing === null ? "" : metrics.gpuMissing === "unreadable" ? "有顯示卡，但目前讀不到它的使用情況；原因寫在「複製診斷資訊」裡。" : "沒有偵測到顯示卡。";
  return (
    <section className="card" aria-label="系統資源">
      <h2 className="card-title">系統資源</h2>
      <div className="card-body res-body">
        <div className="res-grid" data-count={tiles.length}>
          {tiles.map((t) => (
            <Tile key={t.key} d={t} />
          ))}
        </div>
        <p className="res-note">{gpuNote}</p>
        <Usage m={metrics} cams={cams} />
      </div>
    </section>
  );
}
