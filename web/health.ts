import type { CameraDto } from "../src/api-types.ts";
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

export type IssueKind = "restream" | "offline" | "notRecording" | "unstable" | "diskLow" | "diskFull";

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
  // 穩定排序：同色調維持上面的先後（系統 → 攝影機 → 磁碟）
  issues.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "bad" ? -1 : 1));
  return { issues, statuses, disk: { usedPct, free, total, tone: diskTone } };
}

/** 首頁提醒的文字：「1 台連不上、2 台沒在錄影」；沒有問題時是 null */
export function alertSummary(issues: Issue[]): string | null {
  return issues.length ? issues.map((i) => i.short).join("、") : null;
}
