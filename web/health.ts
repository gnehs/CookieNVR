import type { CameraDto, DetectFrameState, MetricsPointDto } from "../src/api-types.ts";
import type { CameraId, WorkerStatus } from "../src/types.ts";

export type CameraStatusKind = "recording" | "unstable" | "notRecording" | "offline" | "viewOnly" | "disabled";
export type StatusTone = "ok" | "warn" | "bad" | "muted";

export interface CameraStatus {
  kind: CameraStatusKind;
  label: string;
  tone: StatusTone;
  /** 需要使用者處理：會出現在狀態頁、首頁提醒與導覽的提示點 */
  problem: boolean;
  /** 首頁畫面上不需要標出來的正常狀態 */
  quiet: boolean;
}

/** 每個攝影機狀態在全站只有這一種說法與色調；紅色只留給需要處理的狀態 */
const STATUS: Record<CameraStatusKind, Omit<CameraStatus, "kind">> = {
  recording: { label: "錄影中", tone: "ok", problem: false, quiet: false },
  unstable: { label: "錄影不穩定", tone: "warn", problem: true, quiet: false },
  notRecording: { label: "沒在錄影", tone: "bad", problem: true, quiet: false },
  offline: { label: "連不上", tone: "bad", problem: true, quiet: false },
  viewOnly: { label: "不錄影", tone: "muted", problem: false, quiet: true },
  disabled: { label: "已停用", tone: "muted", problem: false, quiet: false },
};

export function cameraStatus(cam: Pick<CameraDto, "config" | "online" | "recording">, opts: { unstable?: boolean } = {}): CameraStatus {
  const c = cam.config;
  const kind: CameraStatusKind = !c.enabled
    ? "disabled"
    : !cam.online
      ? "offline"
      : !c.record.enabled
        ? "viewOnly"
        : !cam.recording
          ? "notRecording"
          : opts.unstable
            ? "unstable"
            : "recording";
  return { kind, ...STATUS[kind] };
}

export type IssueKind = "restream" | "offline" | "notRecording" | "unstable" | "diskLow" | "diskFull" | "cpuBusy" | "memoryHigh";

export interface Issue {
  kind: IssueKind;
  tone: "bad" | "warn";
  /** 同類問題合併成一筆；系統層級的問題沒有攝影機 */
  cameras: { id: CameraId; name: string }[];
  title: string;
  /** 首頁提醒用的短句，例如「2 台沒在錄影」 */
  short: string;
}

export interface HealthInput {
  cams: CameraDto[];
  workers: WorkerStatus[];
  disk: { totalBytes: number; freeBytes: number };
  minFreeBytes: number;
  /** 系統資源的近期走勢（`MetricsDto.history`）；沒有時不判斷資源吃緊 */
  resources?: MetricsPointDto[] | null;
}

export interface Health {
  issues: Issue[];
  statuses: Map<CameraId, CameraStatus>;
  disk: { usedPct: number; free: number; total: number; tone: StatusTone };
}

const CAMERA_ISSUES: { kind: Extract<IssueKind, CameraStatusKind>; tone: "bad" | "warn"; one: (n: string) => string; many: string }[] = [
  { kind: "offline", tone: "bad", one: (n) => `${n}連不上`, many: "連不上" },
  { kind: "notRecording", tone: "bad", one: (n) => `${n}沒在錄影`, many: "沒在錄影" },
  { kind: "unstable", tone: "warn", one: (n) => `${n}的錄影不穩定`, many: "錄影不穩定" },
];

/** 把攝影機、worker 與磁碟換成使用者在意的問題；同一種問題只列一次 */
export function assessHealth(input: HealthInput): Health {
  const worker = (id: string) => input.workers.find((w) => w.id === id);
  const statuses = new Map<CameraId, CameraStatus>();
  for (const cam of input.cams) statuses.set(cam.id, cameraStatus(cam, { unstable: worker(`record:${cam.id}`)?.unstable }));

  const issues: Issue[] = [];
  const restream = worker("restream");
  if (restream && (restream.state === "backoff" || restream.state === "stopped" || restream.unstable)) {
    issues.push({ kind: "restream", tone: "bad", cameras: [], title: "影像服務沒有正常運作", short: "影像服務停止" });
  }
  for (const g of CAMERA_ISSUES) {
    const cameras = input.cams.filter((c) => statuses.get(c.id)!.kind === g.kind).map((c) => ({ id: c.id, name: c.config.name }));
    if (cameras.length === 0) continue;
    const title = cameras.length === 1 ? g.one(cameras[0]!.name) : `${cameras.length} 台${g.many}：${cameras.map((c) => c.name).join("、")}`;
    issues.push({ kind: g.kind, tone: g.tone, cameras, title, short: `${cameras.length} 台${g.many}` });
  }

  const { totalBytes: total, freeBytes: free } = input.disk;
  const usedPct = total ? ((total - free) / total) * 100 : 0;
  let diskTone: StatusTone = "ok";
  if (free < input.minFreeBytes) {
    diskTone = "bad";
    issues.push({ kind: "diskLow", tone: "bad", cameras: [], title: "儲存空間不足", short: "儲存空間不足" });
  } else if (usedPct >= 90) {
    diskTone = "warn";
    issues.push({ kind: "diskFull", tone: "warn", cameras: [], title: "儲存空間快滿了", short: "儲存空間快滿了" });
  }
  const pressure = resourcePressure(input.resources ?? []);
  if (pressure.cpu) issues.push({ kind: "cpuBusy", tone: "warn", cameras: [], title: "處理器長時間忙碌", short: "處理器長時間忙碌" });
  if (pressure.memory) issues.push({ kind: "memoryHigh", tone: "warn", cameras: [], title: "記憶體快不夠了", short: "記憶體快不夠了" });
  // 穩定排序：同色調維持上面的先後（系統 → 攝影機 → 磁碟 → 資源）
  issues.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "bad" ? -1 : 1));
  return { issues, statuses, disk: { usedPct, free, total, tone: diskTone } };
}

/**
 * 資源吃緊的門檻。刻意保守：要整整 5 分鐘、九成以上的取樣都在 90% 以上才算，
 * 錄影開始、轉檔或匯出這類幾十秒的尖峰不會讓首頁跳出提醒。
 */
export const PRESSURE = { windowMs: 5 * 60_000, pct: 90, share: 0.9, minSamples: 30 } as const;

/** 依近期走勢判斷 CPU 與記憶體是否長時間偏高；取樣涵蓋不到整個時間窗（剛啟動、剛重連）就不判斷 */
export function resourcePressure(history: readonly MetricsPointDto[]): { cpu: boolean; memory: boolean } {
  const last = history.at(-1);
  if (!last || history[0]!.at > last.at - PRESSURE.windowMs) return { cpu: false, memory: false };
  const recent = history.filter((p) => p.at >= last.at - PRESSURE.windowMs);
  const sustained = (values: number[]) => values.length >= PRESSURE.minSamples && values.filter((v) => v >= PRESSURE.pct).length >= values.length * PRESSURE.share;
  return {
    cpu: sustained(recent.map((p) => p.cpuPct).filter((v): v is number => v !== null)),
    memory: sustained(recent.map((p) => p.memPct)),
  };
}

/** 首頁提醒的文字：「1 台連不上、2 台沒在錄影」；沒有問題時是 null */
export function alertSummary(issues: Issue[]): string | null {
  return issues.length ? issues.map((i) => i.short).join("、") : null;
}

/** 有進行中的事件：首頁卡片的提示與事件頁的標示。用主色，不用紅色（紅色只代表需要處理） */
export const EVENT_ACTIVE = { label: "偵測到動作", badge: "進行中" } as const;

/** 偵測設定頁的即時畫面變化：分數算不出來時的一句話 */
export const DETECT_FRAME_TEXT: Record<Exclude<DetectFrameState, "ok">, string> = {
  warmup: "正在熟悉畫面，幾秒後開始",
  paused: "鏡頭轉動中，暫停偵測",
  light: "光線突然改變，重新適應中",
  off: "儲存後開始比對畫面變化",
};

/** 即時畫面變化右上角的狀態 */
export const MOTION_LEVEL_TEXT = { calm: "沒有動作", motion: "偵測到動作", event: "事件進行中", lost: "暫時看不到即時變化" } as const;
