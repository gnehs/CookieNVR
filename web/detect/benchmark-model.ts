import type { BenchmarkDto, BenchmarkResultDto, InferenceDeviceDto, ObjectModelDto } from "../../src/api-types.ts";
import { rateClause, rateText, tidyName } from "./object-model.ts";

/** 換算的假設，一句話；數字對應 src/objects/capacity.ts 的 HEADROOM */
export const BENCHMARK_ASSUMPTION = "只在有動作時才辨識，換算時已替錄影與解碼保留餘裕（處理器留一半、顯卡留兩成）。";

export const BENCHMARK_RUNNING_NOTE = "測速期間辨識會暫停，事件照常記錄（設為「過濾」的攝影機暫時改成標註）。每個裝置約需十幾秒，第一次使用顯卡可能更久。";

export type Tone = "ok" | "warn" | "bad";

export interface BenchmarkRow {
  device: string;
  name: string;
  /** 「約 4 台」「太慢，連 1 台也撐不住」「無法測速」 */
  text: string;
  tone: Tone;
  /** 目前使用中的裝置 */
  current: boolean;
  /** 幾個裝置比較時，最快的那個 */
  best: boolean;
  /** 收在「詳細數字」裡的一句話；失敗時是原因 */
  detail: string | null;
}

export interface BenchmarkView {
  headline: { tone: Tone; text: string } | null;
  /** 對照目前設定夠不夠用 */
  verdict: { tone: Tone; text: string } | null;
  rows: BenchmarkRow[];
  /** 「上次測速：11/19 14:32・內建模型」 */
  meta: string;
  stale: boolean;
}

type Good = BenchmarkResultDto & { fps: number; cameras: number };
const okResults = (b: BenchmarkDto): Good[] => b.results.filter((r): r is Good => r.ok && r.fps !== undefined && r.cameras !== undefined);

const rowText = (cameras: number) => (cameras > 0 ? `約 ${cameras} 台` : "太慢，連 1 台也撐不住");

function detailOf(r: BenchmarkResultDto): string | null {
  if (!r.ok) return r.error ?? null;
  const parts: string[] = [];
  if (r.fps !== undefined) parts.push(`每秒約 ${r.fps.toFixed(1)} 張`);
  if (r.msMean !== undefined) parts.push(`平均每張 ${Math.round(r.msMean)} 毫秒`);
  if (r.msP90 !== undefined) parts.push(`最慢的一成約 ${Math.round(r.msP90)} 毫秒`);
  if (r.loadMs !== undefined) parts.push(`載入花了 ${(r.loadMs / 1000).toFixed(1)} 秒`);
  return parts.length ? parts.join("，") : null;
}

/** 結論一句話：以目前使用的裝置為準；沒測到它就用最快的 */
export function headlineOf(b: BenchmarkDto, currentDevice: string | null): BenchmarkView["headline"] {
  const ok = okResults(b);
  if (ok.length === 0) return null;
  const pick = ok.find((r) => r.device === currentDevice) ?? ok.reduce((a, r) => (r.cameras > a.cameras || (r.cameras === a.cameras && r.fps > a.fps) ? r : a));
  if (pick.cameras <= 0) return { tone: "bad", text: `這個裝置太慢，撐不住 1 台攝影機${rateText(b.perCameraFps)}的辨識。建議降低辨識頻率，或換更快的裝置。` };
  return { tone: "ok", text: `這台機器大約可以同時處理 ${pick.cameras} 台攝影機（每台${rateClause(b.perCameraFps)}）` };
}

export function verdictOf(b: BenchmarkDto): BenchmarkView["verdict"] {
  const v = b.verdict;
  if (b.stale) return null;
  if (!v) return okResults(b).length ? { tone: "warn", text: "這次沒有測目前使用的裝置，想知道夠不夠用，請測一次目前使用的裝置。" } : null;
  if (v.cameras === 0) return { tone: "ok", text: "目前沒有攝影機開啟物件辨識。" };
  if (v.state === "enough") return { tone: "ok", text: `目前開啟物件辨識的 ${v.cameras} 台攝影機，同時都有動作也來得及。` };
  return { tone: "warn", text: `目前有 ${v.cameras} 台攝影機開了物件辨識，同時都有動作時最多處理 ${v.supported} 台，其餘的畫面會被略過。可以降低辨識頻率，或換更快的裝置。` };
}

export function benchmarkView(b: BenchmarkDto, opts: { currentDevice: string | null; models: readonly ObjectModelDto[]; formatTime: (ms: number) => string }): BenchmarkView {
  const ok = okResults(b);
  const top = ok.length > 1 ? Math.max(...ok.map((r) => r.cameras)) : -1;
  const topFps = ok.length > 1 ? Math.max(...ok.filter((r) => r.cameras === top).map((r) => r.fps)) : -1;
  const rows = b.results.map<BenchmarkRow>((r) => ({
    device: r.device,
    name: tidyName(r.name),
    text: r.ok && r.cameras !== undefined ? rowText(r.cameras) : "無法測速",
    tone: !r.ok ? "bad" : (r.cameras ?? 0) > 0 ? "ok" : "bad",
    current: r.device === opts.currentDevice,
    best: ok.length > 1 && r.ok && r.cameras === top && r.fps === topFps,
    detail: detailOf(r),
  }));
  const model = opts.models.find((m) => m.id === b.model)?.name ?? b.model;
  const verdict = verdictOf(b);
  const head = headlineOf(b, opts.currentDevice);
  return {
    // 結論本身沒問題，但對照目前設定不夠用時，不要用綠色打勾蓋過下面的提醒
    headline: head && head.tone === "ok" && verdict?.tone === "warn" ? { ...head, tone: "warn" } : head,
    verdict,
    rows,
    meta: ["上次測速：" + opts.formatTime(b.finishedAt ?? b.startedAt), b.results.length === 1 ? rows[0]!.name : null, model === "builtin" ? "內建模型" : model].filter(Boolean).join("・"),
    stale: b.stale,
  };
}

export interface BenchmarkProgress {
  /** 「第 2 個裝置，共 3 個：NVIDIA GeForce GTX 1650」 */
  text: string;
  /** 整體進度 0 到 1 */
  fraction: number;
}

/** progress.index 從 0 起算，fraction 是目前這個裝置的進度 */
export function progressOf(b: BenchmarkDto, devices: readonly InferenceDeviceDto[]): BenchmarkProgress {
  const p = b.progress;
  if (!p || p.total <= 0) return { text: "準備中…", fraction: 0 };
  const name = devices.find((d) => d.id === p.device)?.name;
  const where = p.total > 1 ? `第 ${p.index + 1} 個裝置，共 ${p.total} 個` : "測量中";
  return { text: name ? `${where}：${tidyName(name)}` : where, fraction: Math.min(1, Math.max(0, (p.index + p.fraction) / p.total)) };
}

/** 結束但沒有結果的狀態說明 */
export function endedText(b: BenchmarkDto): { tone: Tone; text: string } | null {
  if (b.state === "cancelled") return { tone: "warn", text: "測速已取消。" };
  if (b.state === "failed") return { tone: "bad", text: b.error ?? "測速沒有完成，請稍後再試。" };
  return null;
}
