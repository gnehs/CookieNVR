import type { CameraDto, GpuDto, MetricsDto, MetricsPointDto, UsageCategory } from "../src/api-types.ts";
import { formatBytes, h, segmented } from "./dom.ts";

/** 「資源花在哪裡」的類別名稱；狀態頁的資源警告也用它說明誰用最多 */
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

interface TileData {
  label: string;
  /** 大數字，例如「23%」；讀不到時是「—」 */
  value: string;
  sub: string;
  pct: number | null;
  series: { at: number; v: number | null }[];
  now: number;
  extras?: string[];
}

const pctText = (v: number | null) => (v === null ? "—" : `${Math.round(v)}%`);

/** 一小段近期走勢：時間軸固定 10 分鐘，缺的取樣留白，不連線 */
function sparkPath(series: TileData["series"], now: number): { line: string; area: string } {
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

function trendText(label: string, series: TileData["series"]): string {
  const v = series.map((p) => p.v).filter((n): n is number => n !== null);
  if (v.length < 2) return `${label}的近期走勢：還在收集`;
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  return `${label}最近 10 分鐘：平均 ${Math.round(avg)}%，最高 ${Math.round(Math.max(...v))}%`;
}

const SVG = "http://www.w3.org/2000/svg";
const svg = (tag: string, attrs: Record<string, string>) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

function createTile() {
  const label = h("span", { class: "res-label" });
  const value = h("b", { class: "res-value num" });
  const sub = h("span", { class: "res-sub num" });
  const fill = h("i");
  const bar = h("div", { class: "res-bar", role: "meter", "aria-valuemin": "0", "aria-valuemax": "100" }, fill);
  const area = svg("path", { class: "res-spark-area" });
  const line = svg("path", { class: "res-spark-line", "vector-effect": "non-scaling-stroke" });
  const spark = svg("svg", { class: "res-spark", viewBox: "0 0 100 28", preserveAspectRatio: "none", role: "img" });
  spark.append(area, line);
  const extras = h("ul", { class: "res-extras" });
  const el = h("div", { class: "res-tile", role: "group" }, h("div", { class: "res-head" }, label, value), bar, spark, sub, extras);
  return {
    el,
    update(d: TileData) {
      el.setAttribute("aria-label", d.label);
      label.textContent = d.label;
      label.title = d.label;
      value.textContent = d.value;
      sub.textContent = d.sub;
      const p = d.pct === null ? 0 : Math.min(100, Math.max(0, d.pct));
      fill.style.transform = `scaleX(${p / 100})`;
      el.dataset.tone = d.pct !== null && d.pct >= HIGH_PCT ? "warn" : "";
      bar.hidden = d.pct === null;
      bar.setAttribute("aria-label", `${d.label}使用率`);
      bar.setAttribute("aria-valuenow", String(Math.round(p)));
      bar.setAttribute("aria-valuetext", d.value);
      const path = sparkPath(d.series, d.now);
      line.setAttribute("d", path.line);
      area.setAttribute("d", path.area);
      spark.setAttribute("aria-label", trendText(d.label, d.series));
      extras.replaceChildren(...(d.extras ?? []).map((t) => h("li", null, t)));
      extras.hidden = !d.extras?.length;
    },
  };
}

function createRow() {
  const name = h("span", { class: "res-row-name" });
  const fill = h("i");
  const value = h("span", { class: "num" });
  const el = h("div", { class: "res-row" }, name, h("div", { class: "res-row-bar", "aria-hidden": "true" }, fill), value);
  return {
    el,
    update(label: string, share: number, text: string, muted: boolean) {
      name.textContent = label;
      name.title = label;
      value.textContent = text;
      fill.style.transform = `scaleX(${Math.min(1, Math.max(0, share))})`;
      el.classList.toggle("muted-row", muted);
    },
  };
}

/** 依 key 重用列，數值更新時寬度能平順過渡；清單組成改變才調整 DOM 順序 */
function keyedList<T extends { el: HTMLElement }>(box: HTMLElement, make: () => T) {
  const rows = new Map<string, T>();
  let order = "";
  return (keys: string[]): Map<string, T> => {
    for (const k of keys) if (!rows.has(k)) rows.set(k, make());
    for (const k of [...rows.keys()]) if (!keys.includes(k)) rows.delete(k);
    if (keys.join("\n") !== order) {
      order = keys.join("\n");
      box.replaceChildren(...keys.map((k) => rows.get(k)!.el));
    }
    return rows;
  };
}

function gpuTile(g: GpuDto, history: MetricsPointDto[], now: number): TileData {
  const parts: string[] = [];
  if (g.memory) parts.push(`顯示記憶體 ${formatBytes(g.memory.usedBytes)} / ${formatBytes(g.memory.totalBytes)}`);
  if (g.temperatureC !== null) parts.push(`${g.temperatureC}°C`);
  if (g.note) parts.push(g.note);
  if (!parts.length) parts.push(g.utilPct === null ? "使用率無法取得" : g.memory === null ? "與系統共用記憶體" : "使用率");
  return {
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

/** 狀態頁的「系統資源」卡：CPU、記憶體、每張 GPU 一格，下面是依類別的用量 */
export function createResourcesCard() {
  const grid = h("div", { class: "res-grid" });
  const gpuNote = h("p", { class: "res-note" });
  let mode: Mode = "cpu";
  let last: { m: MetricsDto; cams: CameraDto[] } | null = null;
  const toggle = segmented<Mode>(
    "用量依",
    [
      { value: "cpu", label: "處理器" },
      { value: "memory", label: "記憶體" },
    ],
    mode,
    (v) => {
      mode = v;
      if (last) paintUsage(last.m, last.cams);
    },
  );
  const usageHint = h("p", { class: "res-note" });
  const usageRows = h("div", { class: "res-rows" });
  const camRows = h("div", { class: "res-rows" });
  const camDetails = h(
    "details",
    { class: "more res-cams" },
    h("summary", null, "依攝影機查看"),
    camRows,
    h("p", { class: "res-note" }, "影像服務、Apple 家庭與系統本身由所有攝影機共用，沒有算在個別攝影機裡。"),
  );
  const usage = h(
    "div",
    { class: "res-usage" },
    h("div", { class: "res-usage-head" }, h("h3", null, "資源花在哪裡"), toggle),
    usageHint,
    usageRows,
    camDetails,
  );
  const el = h("section", { class: "card", "aria-label": "系統資源" }, h("h2", { class: "card-title" }, "系統資源"), h("div", { class: "card-body res-body" }, grid, gpuNote, usage));

  const tiles = keyedList(grid, createTile);
  const rows = keyedList(usageRows, createRow);
  const cams = keyedList(camRows, createRow);

  function paintUsage(m: MetricsDto, camList: CameraDto[]) {
    const value = (u: { cpuPct: number; memBytes: number }) => (mode === "cpu" ? u.cpuPct : u.memBytes);
    const text = (v: number) => (mode === "cpu" ? (v > 0 && v < 1 ? "<1%" : `${Math.round(v)}%`) : formatBytes(v));
    usage.hidden = false;
    if (!m.usage) {
      usageHint.textContent = "正在計算…";
      rows([]);
      camDetails.hidden = true;
      return;
    }
    usageHint.textContent = mode === "cpu" ? `以${m.cpu.scope === "container" ? "可用的" : "整台機器的"}處理器為 100%` : "各項工作占用的記憶體";
    const list = m.usage.filter((u) => value(u) > 0 && (mode === "memory" || u.cpuPct >= 0.05));
    const otherLabel = m.memory.scope === "host" || m.cpu.scope === "host" ? (mode === "cpu" ? "其他程式" : "其他程式與快取") : "其他";
    const entries = list.map((u) => ({ key: u.category as string, label: CATEGORY_LABEL[u.category], v: value(u), muted: false }));
    if (m.other && value(m.other) > 0) entries.push({ key: "other", label: otherLabel, v: value(m.other), muted: true });
    const max = Math.max(1e-9, ...entries.map((e) => e.v));
    const r = rows(entries.map((e) => e.key));
    for (const e of entries) r.get(e.key)!.update(e.label, e.v / max, text(e.v), e.muted);

    const perCam = new Map<string, number>();
    for (const u of m.usage) for (const c of u.cameras) perCam.set(c.cameraId, (perCam.get(c.cameraId) ?? 0) + value(c));
    const camEntries = camList.filter((c) => perCam.has(c.id)).map((c) => ({ key: c.id, label: c.config.name, v: perCam.get(c.id)! }));
    camDetails.hidden = camEntries.length === 0;
    const camMax = Math.max(1e-9, ...camEntries.map((e) => e.v));
    const cr = cams(camEntries.map((e) => e.key));
    for (const e of camEntries) cr.get(e.key)!.update(e.label, e.v / camMax, text(e.v), false);
  }

  function update(m: MetricsDto, camList: CameraDto[]) {
    last = { m, cams: camList };
    const now = m.at;
    const memPct = m.memory.totalBytes ? (m.memory.usedBytes / m.memory.totalBytes) * 100 : null;
    const limited = (scope: string) => scope === "container";
    const cpuCores = Number.isInteger(m.cpu.cores) ? m.cpu.cores : m.cpu.cores.toFixed(1);
    const data: [string, TileData][] = [
      [
        "cpu",
        {
          label: "處理器",
          value: pctText(m.cpu.pct),
          pct: m.cpu.pct,
          sub: limited(m.cpu.scope) ? `上限 ${cpuCores} 核心` : `共 ${cpuCores} 核心`,
          series: m.history.map((p) => ({ at: p.at, v: p.cpuPct })),
          now,
        },
      ],
      [
        "memory",
        {
          label: "記憶體",
          value: pctText(memPct),
          pct: memPct,
          sub: `${formatBytes(m.memory.usedBytes)} / ${limited(m.memory.scope) ? "上限 " : ""}${formatBytes(m.memory.totalBytes)}`,
          series: m.history.map((p) => ({ at: p.at, v: p.memPct })),
          now,
        },
      ],
      ...m.gpus.map((g): [string, TileData] => [g.id, gpuTile(g, m.history, now)]),
    ];
    const t = tiles(data.map(([k]) => k));
    for (const [k, d] of data) t.get(k)!.update(d);
    grid.dataset.count = String(data.length);

    gpuNote.hidden = m.gpus.length > 0 || m.gpuMissing === null;
    gpuNote.textContent = m.gpuMissing === "unreadable" ? "有顯示卡，但目前讀不到它的使用情況；原因寫在「複製診斷資訊」裡。" : "沒有偵測到顯示卡。";
    paintUsage(m, camList);
  }

  return { el, update };
}
