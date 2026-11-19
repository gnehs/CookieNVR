import type { CameraDto, DetectFrameState, MetricsPointDto, StateSensorDto } from "../src/api-types.ts";
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

export type IssueKind =
  | "restream"
  | "objects"
  | "objectsLoad"
  | "offline"
  | "notRecording"
  | "unstable"
  | "diskLow"
  | "diskFull"
  | "dataDiskLow"
  | "cpuBusy"
  | "memoryHigh"
  | "decode"
  | "stateUntrained"
  | "stateStale"
  | "stateNoFrames"
  | "stateWorker";

export interface Issue {
  kind: IssueKind;
  tone: "bad" | "warn";
  /** 同類問題合併成一筆；系統層級的問題沒有攝影機 */
  cameras: { id: CameraId; name: string }[];
  title: string;
  /** 首頁提醒用的短句，例如「2 台沒在錄影」 */
  short: string;
  /** 一句白話說明（影像解碼退回處理器、RTSP port 被佔用、錄影沒有寫入權限），狀態頁直接顯示 */
  detail?: string;
  /** 狀態感應器的問題：是哪幾個感應器（狀態頁的按鈕直接帶到它的頁面） */
  sensors?: { id: string; cameraId: CameraId; name: string }[];
}

export interface HealthInput {
  cams: CameraDto[];
  workers: WorkerStatus[];
  disk: { totalBytes: number; freeBytes: number };
  /** `SystemDto.dataDisk`：和錄影同一顆時不另外判斷（錄影那顆的提醒已經涵蓋） */
  dataDisk?: { totalBytes: number; freeBytes: number; sameAsRecordings: boolean } | null;
  minFreeBytes: number;
  /** 系統資源的近期走勢（`MetricsDto.history`）；沒有時不判斷資源吃緊 */
  resources?: MetricsPointDto[] | null;
  /** `SystemDto.decode.warning`：影像解碼退回處理器的說明；沒有退回或讀不到時為 null */
  decodeWarning?: string | null;
  /** 狀態感應器（`statesQuery`）；沒有時不判斷 */
  stateSensors?: StateSensorDto[] | null;
}

export interface Health {
  issues: Issue[];
  statuses: Map<CameraId, CameraStatus>;
  disk: { usedPct: number; free: number; total: number; tone: StatusTone };
  /** appdata 那顆；和錄影同一顆時為 null */
  dataDisk: { free: number; total: number; tone: StatusTone } | null;
}

/**
 * appdata（/data）那顆的提醒門檻。保留規則只會在錄影那顆騰空間，這顆滿了沒有東西會自動清，
 * 所以用絕對值而不是比例：資料庫、每天的備份與縮圖只要幾百 MB 到幾 GB，但一段 2 小時的匯出就要好幾 GB；
 * 剩不到 5 GB 時匯出很快會失敗，剩不到 1 GB 時資料庫的備份與寫入也可能失敗。
 */
export const DATA_DISK = { warnBytes: 5 * 1024 ** 3, badBytes: 1024 ** 3 } as const;

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
    // MediaMTX 綁不到 RTSP port 時重啟也沒用，要讓使用者知道是 port 被佔用
    const portTaken = restream.stderrTail.some((line) => line.includes("address already in use"));
    issues.push({
      kind: "restream",
      tone: "bad",
      cameras: [],
      title: "影像服務沒有正常運作",
      short: "影像服務停止",
      ...(portTaken ? { detail: "RTSP 轉發要用的 port 已經被這台主機上的其他程式使用" } : {}),
    });
  }
  // 物件辨識沒開時 detector worker 不存在；有就代表使用者開了它
  const detector = worker("detector");
  if (detector && (detector.state === "backoff" || detector.state === "stopped" || detector.unstable)) {
    issues.push({ kind: "objects", tone: "warn", cameras: [], title: "物件辨識沒有正常運作", short: "物件辨識停止" });
  }
  if (input.decodeWarning) {
    issues.push({ kind: "decode", tone: "warn", cameras: [], title: "影像解碼改用處理器", short: "影像解碼改用處理器", detail: input.decodeWarning });
  }
  // 錄影寫不進儲存位置時重新開始也沒用，要讓使用者知道是權限；這些攝影機另外列一張
  const denied = (id: CameraId) => worker(`record:${id}`)?.stderrTail.some((l) => l.includes("Permission denied")) ?? false;
  for (const g of CAMERA_ISSUES) {
    const all = input.cams.filter((c) => statuses.get(c.id)!.kind === g.kind).map((c) => ({ id: c.id, name: c.config.name }));
    const groups = g.kind === "offline" ? [{ cameras: all, denied: false }] : [{ cameras: all.filter((c) => denied(c.id)), denied: true }, { cameras: all.filter((c) => !denied(c.id)), denied: false }];
    for (const { cameras, denied: d } of groups) {
      if (cameras.length === 0) continue;
      const title = cameras.length === 1 ? g.one(cameras[0]!.name) : `${cameras.length} 台${g.many}：${cameras.map((c) => c.name).join("、")}`;
      issues.push({ kind: g.kind, tone: g.tone, cameras, title, short: `${cameras.length} 台${g.many}`, ...(d ? { detail: "沒有權限寫入錄影位置" } : {}) });
    }
  }

  issues.push(...stateIssues(input, statuses, worker("classifier")));

  const { totalBytes: total, freeBytes: free } = input.disk;
  const usedPct = total ? ((total - free) / total) * 100 : 0;
  let diskTone: StatusTone = "ok";
  // 有兩顆硬碟時說清楚是錄影那顆
  const what = input.dataDisk && !input.dataDisk.sameAsRecordings ? "錄影硬碟的空間" : "儲存空間";
  if (free < input.minFreeBytes) {
    diskTone = "bad";
    issues.push({ kind: "diskLow", tone: "bad", cameras: [], title: `${what}不足`, short: `${what}不足` });
  } else if (usedPct >= 90) {
    diskTone = "warn";
    issues.push({ kind: "diskFull", tone: "warn", cameras: [], title: `${what}快滿了`, short: `${what}快滿了` });
  }
  let dataDisk: Health["dataDisk"] = null;
  if (input.dataDisk && !input.dataDisk.sameAsRecordings) {
    const { totalBytes, freeBytes } = input.dataDisk;
    const tone: StatusTone = freeBytes < DATA_DISK.badBytes ? "bad" : freeBytes < DATA_DISK.warnBytes ? "warn" : "ok";
    dataDisk = { free: freeBytes, total: totalBytes, tone };
    if (tone !== "ok") {
      const title = tone === "bad" ? "appdata 硬碟的空間不足" : "appdata 硬碟快滿了";
      issues.push({ kind: "dataDiskLow", tone, cameras: [], title, short: title });
    }
  }
  const pressure = resourcePressure(input.resources ?? []);
  if (pressure.cpu) issues.push({ kind: "cpuBusy", tone: "warn", cameras: [], title: "處理器長時間忙碌", short: "處理器長時間忙碌" });
  if (pressure.memory) issues.push({ kind: "memoryHigh", tone: "warn", cameras: [], title: "記憶體快不夠了", short: "記憶體快不夠了" });
  // 穩定排序：同色調維持上面的先後（系統 → 攝影機 → 磁碟 → 資源）
  issues.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "bad" ? -1 : 1));
  return { issues, statuses, disk: { usedPct, free, total, tone: diskTone }, dataDisk };
}

const STATE_ISSUES: { kind: Extract<IssueKind, `state${string}`>; code: "untrained" | "stale-model" | "camera-off"; one: (n: string) => string; many: (n: number) => string }[] = [
  { kind: "stateStale", code: "stale-model", one: (n) => `「${n}」要重新訓練`, many: (n) => `${n} 個狀態感應器要重新訓練` },
  { kind: "stateUntrained", code: "untrained", one: (n) => `「${n}」還沒訓練`, many: (n) => `${n} 個狀態感應器還沒訓練` },
  { kind: "stateNoFrames", code: "camera-off", one: (n) => `「${n}」看不到畫面`, many: (n) => `${n} 個狀態感應器看不到畫面` },
];

/**
 * 狀態感應器沒在辨識的原因。暫停（使用者自己關的、鏡頭移動中）不是問題；
 * 攝影機停用或連不上時，攝影機那張卡已經說了，這裡不重複。辨識程序的問題所有感應器共用一張。
 */
function stateIssues(input: HealthInput, statuses: Map<CameraId, CameraStatus>, classifier: WorkerStatus | undefined): Issue[] {
  const sensors = (input.stateSensors ?? []).filter((s) => s.problem && s.problem.code !== "disabled" && s.problem.code !== "paused");
  const camName = (id: CameraId) => input.cams.find((c) => c.id === id)?.config.name ?? "";
  const ref = (s: StateSensorDto) => ({ id: s.id, cameraId: s.cameraId, name: s.config.name });
  const issues: Issue[] = [];
  const brokenWorker = classifier && (classifier.state === "backoff" || classifier.state === "stopped" || classifier.unstable);
  const workerSensors = sensors.filter((s) => s.problem!.code === "worker");
  if (workerSensors.length || brokenWorker) {
    issues.push({ kind: "stateWorker", tone: "warn", cameras: [], title: "狀態辨識沒有正常運作", short: "狀態辨識停止", sensors: workerSensors.map(ref), ...(workerSensors[0] ? { detail: workerSensors[0].problem!.message } : {}) });
  }
  for (const g of STATE_ISSUES) {
    const list = sensors.filter((s) => {
      if (s.problem!.code !== g.code) return false;
      if (g.code !== "camera-off") return true;
      const st = statuses.get(s.cameraId)?.kind;
      return st !== undefined && st !== "disabled" && st !== "offline";
    });
    if (!list.length) continue;
    const cameras = [...new Set(list.map((s) => s.cameraId))].map((id) => ({ id, name: camName(id) }));
    const title = list.length === 1 ? g.one(list[0]!.config.name) : g.many(list.length);
    issues.push({ kind: g.kind, tone: "warn", cameras, title, short: title, sensors: list.map(ref) });
  }
  return issues;
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
