import { joinClauses } from "../format.ts";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural, t } from "@lingui/core/macro";
import type { BenchmarkDto, BenchmarkResultDto, InferenceDeviceDto, ObjectModelDto } from "../../src/api-types.ts";
import { cpuShareNote, rateClause, rateText, tidyName } from "./object-model.ts";

/** 換算的假設，一句話；數字對應 src/objects/capacity.ts 的 HEADROOM */
export const BENCHMARK_ASSUMPTION: MessageDescriptor = msg`Detection only runs when there is motion, and the estimate already leaves headroom for recording and decoding (half the CPU, 20% of a graphics card).`;

export const BENCHMARK_RUNNING_NOTE: MessageDescriptor = msg`Detection pauses during the test while events keep being recorded (cameras set to "Filter" temporarily switch to labeling). Each device takes about ten-odd seconds, and the first run on a graphics card may take longer.`;

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
  /** 顯示卡的運算有不少交回處理器時的一句話（「實際上大多在處理器上執行…」） */
  note: { tone: "ok" | "warn"; text: string } | null;
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

const rowText = (cameras: number) => (cameras > 0 ? plural(cameras, { one: "About # camera", other: "About # cameras" }) : t`Too slow to handle even 1 camera`);

function detailOf(r: BenchmarkResultDto): string | null {
  if (!r.ok) return [r.reason, r.error].filter(Boolean).join("; ") || null;
  const parts: string[] = [];
  if (r.fps !== undefined) {
    const fps = r.fps.toFixed(1);
    parts.push(t`${fps} frames per second`);
  }
  if (r.msMean !== undefined) {
    const ms = Math.round(r.msMean);
    parts.push(t`${ms} ms per frame on average`);
  }
  if (r.msP90 !== undefined) {
    const ms = Math.round(r.msP90);
    parts.push(t`${ms} ms for the slowest 10%`);
  }
  if (r.loadMs !== undefined) {
    const seconds = (r.loadMs / 1000).toFixed(1);
    parts.push(t`${seconds} s to load`);
  }
  return parts.length ? joinClauses(parts) : null;
}

/** 結論一句話：以目前使用的裝置為準；沒測到它就用最快的 */
export function headlineOf(b: BenchmarkDto, currentDevice: string | null): BenchmarkView["headline"] {
  const ok = okResults(b);
  if (ok.length === 0) {
    const failed = b.results.find((r) => r.reason);
    return failed?.reason ? { tone: "bad", text: sentence(failed.reason) } : null;
  }
  const pick = ok.find((r) => r.device === currentDevice) ?? ok.reduce((a, r) => (r.cameras > a.cameras || (r.cameras === a.cameras && r.fps > a.fps) ? r : a));
  const rate = rateText(b.perCameraFps);
  if (pick.cameras <= 0) return { tone: "bad", text: t`This device is too slow to keep up with even 1 camera detecting ${rate}. Try lowering the detection rate or switching to a faster device.` };
  const share = cpuShareNote(pick.cpuShare);
  const clause = rateClause(b.perCameraFps);
  const cameras = pick.cameras;
  const text = plural(cameras, {
    one: `This machine can handle about # camera at the same time (each ${clause})`,
    other: `This machine can handle about # cameras at the same time (each ${clause})`,
  });
  if (share?.tone !== "warn") return { tone: "ok", text };
  const device = tidyName(pick.name);
  const shareText = share.text;
  return { tone: "warn", text: t`${text}. ${device}: ${shareText}` };
}

export function verdictOf(b: BenchmarkDto): BenchmarkView["verdict"] {
  const v = b.verdict;
  const cameras = v?.cameras ?? 0;
  if (b.stale) return null;
  if (!v) return okResults(b).length ? { tone: "warn", text: t`The device currently in use wasn't tested this time. Run a test on it to find out whether it is enough.` } : null;
  if (v.cameras === 0) return { tone: "ok", text: t`No cameras have object detection turned on right now.` };
  if (v.state === "enough") return { tone: "ok", text: plural(cameras, { one: "The # camera with object detection on can keep up even when it has motion.", other: "The # cameras with object detection on can all keep up even when they all have motion at once." }) };
  const supported = v.supported;
  return {
    tone: "warn",
    text: plural(cameras, {
      one: `# camera has object detection on, but when it has motion only ${supported} can be handled and the rest of its frames are skipped. Try lowering the detection rate or switching to a faster device.`,
      other: `# cameras have object detection on, but when they all have motion at once only ${supported} can be handled and the rest of their frames are skipped. Try lowering the detection rate or switching to a faster device.`,
    }),
  };
}

export function benchmarkView(b: BenchmarkDto, opts: { currentDevice: string | null; models: readonly ObjectModelDto[]; formatTime: (ms: number) => string }): BenchmarkView {
  const ok = okResults(b);
  const top = ok.length > 1 ? Math.max(...ok.map((r) => r.cameras)) : -1;
  const topFps = ok.length > 1 ? Math.max(...ok.filter((r) => r.cameras === top).map((r) => r.fps)) : -1;
  const rows = b.results.map<BenchmarkRow>((r) => ({
    device: r.device,
    name: tidyName(r.name),
    text: r.ok && r.cameras !== undefined ? rowText(r.cameras) : r.reason ? t`Unavailable` : t`Can't be benchmarked`,
    tone: !r.ok ? "bad" : (r.cameras ?? 0) <= 0 ? "bad" : cpuShareNote(r.cpuShare)?.tone === "warn" ? "warn" : "ok",
    note: r.ok ? cpuShareNote(r.cpuShare) : r.reason ? { tone: "warn", text: r.reason } : null,
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
    meta: [lastTest(opts.formatTime(b.finishedAt ?? b.startedAt)), b.results.length === 1 ? rows[0]!.name : null, model === "builtin" ? t`Built-in model` : model].filter(Boolean).join("・"),
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
  if (!p || p.total <= 0) return { text: t`Preparing…`, fraction: 0 };
  const name = devices.find((d) => d.id === p.device)?.name;
  const current = p.index + 1;
  const total = p.total;
  const where = p.total > 1 ? t`Device ${current} of ${total}` : t`Measuring`;
  const device = name ? tidyName(name) : "";
  return { text: name ? t`${where}: ${device}` : where, fraction: Math.min(1, Math.max(0, (p.index + p.fraction) / p.total)) };
}

/** 結束但沒有結果的狀態說明 */
export function endedText(b: BenchmarkDto): { tone: Tone; text: string } | null {
  if (b.state === "cancelled") return { tone: "warn", text: t`Benchmark cancelled.` };
  if (b.state === "failed") return { tone: "bad", text: b.error ?? t`The benchmark didn't finish. Please try again later.` };
  return null;
}

const sentence = (text: string): string => t`${text}.`;
const lastTest = (time: string): string => t`Last benchmark: ${time}`;
