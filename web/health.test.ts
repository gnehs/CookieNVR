import { describe, expect, test } from "bun:test";
import type { CameraDto } from "../src/api-types.ts";
import type { CameraId, WorkerStatus } from "../src/types.ts";
import { alertSummary, assessHealth, cameraStatus } from "./health.ts";

function cam(id: string, name: string, o: { enabled?: boolean; record?: boolean; online?: boolean; recording?: boolean } = {}): CameraDto {
  return {
    id: id as CameraId,
    position: 0,
    config: { name, enabled: o.enabled ?? true, connection: { type: "tapo", host: "h", username: "u", password: "p" }, record: { enabled: o.record ?? true, audio: true, direct: false } },
    online: o.online ?? true,
    recording: o.recording ?? true,
    rtsp: { main: "", sub: null },
  };
}

function worker(id: string, o: Partial<WorkerStatus> = {}): WorkerStatus {
  return { id, kind: id === "restream" ? "restream" : "record", state: "running", unstable: false, pid: 1, startedAt: 0, restarts: 0, lastRestart: null, stderrTail: [], ...o };
}

const TB = 1024 ** 4;
const healthy = { workers: [worker("restream")], disk: { totalBytes: 2 * TB, freeBytes: TB }, minFreeBytes: 5 * 1024 ** 3 };

describe("cameraStatus", () => {
  test("開了錄影卻沒在錄是問題，用紅色", () => {
    expect(cameraStatus(cam("a", "前門", { recording: false }))).toMatchObject({ kind: "notRecording", label: "沒在錄影", tone: "bad", problem: true });
  });

  test("使用者自己關掉錄影不是問題，中性且首頁不標出", () => {
    expect(cameraStatus(cam("a", "前門", { record: false, recording: false }))).toMatchObject({ kind: "viewOnly", tone: "muted", problem: false, quiet: true });
  });

  test("連不上是問題，即使錄影設定是關的", () => {
    expect(cameraStatus(cam("a", "前門", { online: false, record: false }))).toMatchObject({ kind: "offline", label: "連不上", tone: "bad", problem: true });
  });

  test("已停用是中性，不管其他欄位", () => {
    expect(cameraStatus(cam("a", "前門", { enabled: false, online: false, recording: false }))).toMatchObject({ kind: "disabled", label: "已停用", tone: "muted", problem: false });
  });

  test("正常錄影是平靜的綠色，不是紅色", () => {
    expect(cameraStatus(cam("a", "前門"))).toMatchObject({ kind: "recording", label: "錄影中", tone: "ok", problem: false });
  });

  test("錄影中但 worker 不穩定是警告", () => {
    expect(cameraStatus(cam("a", "前門"), { unstable: true })).toMatchObject({ kind: "unstable", tone: "warn", problem: true });
  });
});

describe("assessHealth", () => {
  test("同類問題合併成一筆，名稱依原順序列出", () => {
    const h = assessHealth({ ...healthy, cams: [cam("a", "前門", { recording: false }), cam("b", "客廳"), cam("c", "車道", { recording: false }), cam("d", "後院", { recording: false })] });
    expect(h.issues).toHaveLength(1);
    expect(h.issues[0]).toMatchObject({ kind: "notRecording", title: "3 台沒在錄影：前門、車道、後院", short: "3 台沒在錄影" });
    expect(h.issues[0]!.cameras.map((c) => c.id)).toEqual(["a", "c", "d"] as CameraId[]);
  });

  test("只有一台時標題直接用名稱", () => {
    const h = assessHealth({ ...healthy, cams: [cam("a", "前門", { online: false })] });
    expect(h.issues.map((i) => i.title)).toEqual(["前門連不上"]);
  });

  test("停用與只看畫面的攝影機不算問題", () => {
    const h = assessHealth({ ...healthy, cams: [cam("a", "前門", { enabled: false, online: false }), cam("b", "客廳", { record: false, recording: false })] });
    expect(h.issues).toEqual([]);
    expect(alertSummary(h.issues)).toBeNull();
  });

  test("紅色的排在警告前面，首頁提醒把各類合成一句", () => {
    const h = assessHealth({
      ...healthy,
      workers: [worker("restream"), worker("record:b", { unstable: true })],
      disk: { totalBytes: 100, freeBytes: 5 },
      minFreeBytes: 1,
      cams: [cam("a", "前門", { online: false }), cam("b", "客廳"), cam("c", "車道", { recording: false })],
    });
    expect(h.issues.map((i) => i.kind)).toEqual(["offline", "notRecording", "unstable", "diskFull"]);
    expect(alertSummary(h.issues)).toBe("1 台連不上、1 台沒在錄影、1 台錄影不穩定、儲存空間快滿了");
  });

  test("影像服務停止與空間不足是系統層級的問題", () => {
    const h = assessHealth({ ...healthy, workers: [worker("restream", { state: "backoff" })], disk: { totalBytes: 100, freeBytes: 1 }, minFreeBytes: 10, cams: [] });
    expect(h.issues.map((i) => [i.kind, i.cameras.length])).toEqual([["restream", 0], ["diskLow", 0]]);
    expect(h.disk.tone).toBe("bad");
  });
});
