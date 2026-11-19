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

  test("RTSP port 被佔用時說出原因，一般的停止沒有說明", () => {
    const taken = worker("restream", { state: "backoff", stderrTail: ["ERR: listen tcp :8554: bind: address already in use"] });
    const h = assessHealth({ ...healthy, workers: [taken], cams: [] });
    expect(h.issues[0]?.detail).toContain("port");
    const plain = assessHealth({ ...healthy, workers: [worker("restream", { state: "backoff" })], cams: [] });
    expect(plain.issues[0]?.detail).toBeUndefined();
  });
});

describe("資源吃緊", () => {
  const points = (minutes: number, cpu: (i: number) => number | null, mem: (i: number) => number = () => 40) =>
    Array.from({ length: minutes * 12 + 1 }, (_, i) => ({ at: 1_000_000 + i * 5_000, cpuPct: cpu(i), memPct: mem(i), gpus: {} }));
  const kinds = (resources: ReturnType<typeof points>) => assessHealth({ ...healthy, cams: [], resources }).issues.map((i) => i.kind);

  test("整整 5 分鐘都在 90% 以上才提醒", () => {
    expect(kinds(points(6, () => 97))).toEqual(["cpuBusy"]);
    expect(kinds(points(6, () => 20, () => 95))).toEqual(["memoryHigh"]);
  });

  test("一兩分鐘的尖峰不算，偶爾掉下來一點也不會漏報", () => {
    expect(kinds(points(10, (i) => (i > 100 ? 100 : 30)))).toEqual([]);
    expect(kinds(points(10, (i) => (i % 20 === 0 ? 70 : 96)))).toEqual(["cpuBusy"]);
    // 一半時間在高點，例如每隔一段時間的轉檔
    expect(kinds(points(10, (i) => (i % 2 ? 100 : 50)))).toEqual([]);
  });

  test("剛啟動、取樣還不滿 5 分鐘時不判斷", () => {
    expect(kinds(points(4, () => 100, () => 100))).toEqual([]);
  });

  test("讀不到 CPU 的取樣不算數，也不會變成警告", () => {
    expect(kinds(points(6, () => null))).toEqual([]);
  });

  test("資源警告排在紅色問題後面，首頁提醒用一般說法", () => {
    const h = assessHealth({ ...healthy, cams: [cam("a", "前門", { online: false })], resources: points(6, () => 99) });
    expect(h.issues.map((i) => i.kind)).toEqual(["offline", "cpuBusy"]);
    expect(alertSummary(h.issues)).toBe("1 台連不上、處理器長時間忙碌");
  });
});

describe("物件辨識 detector", () => {
  const detector = (o: Partial<WorkerStatus> = {}) => worker("detector", { kind: "detector", ...o });

  test("沒開物件辨識（沒有 detector worker）或運作正常都沒有提醒", () => {
    expect(assessHealth({ ...healthy, cams: [] }).issues).toEqual([]);
    expect(assessHealth({ ...healthy, workers: [worker("restream"), detector()], cams: [] }).issues).toEqual([]);
  });

  test("detector 一直重啟是警告，不影響攝影機與錄影的問題", () => {
    const h = assessHealth({ ...healthy, workers: [worker("restream"), detector({ state: "backoff" })], cams: [] });
    expect(h.issues).toMatchObject([{ kind: "objects", tone: "warn", short: "物件辨識停止" }]);
  });
});

describe("影像解碼退回處理器", () => {
  const warning = "客廳改用處理器解碼：容器裡沒有 /dev/dri";

  test("解碼有警告時多一筆黃色問題，帶著後端的說明", () => {
    const h = assessHealth({ ...healthy, cams: [], decodeWarning: warning });
    expect(h.issues).toEqual([{ kind: "decode", tone: "warn", cameras: [], title: "影像解碼改用處理器", short: "影像解碼改用處理器", detail: warning }]);
  });

  test("沒有警告或讀不到時不提醒", () => {
    expect(assessHealth({ ...healthy, cams: [], decodeWarning: null }).issues).toEqual([]);
    expect(assessHealth({ ...healthy, cams: [] }).issues).toEqual([]);
  });

  test("排在紅色問題後面，首頁提醒合成一句", () => {
    const h = assessHealth({ ...healthy, cams: [cam("a", "前門", { online: false })], decodeWarning: warning });
    expect(h.issues.map((i) => i.kind)).toEqual(["offline", "decode"]);
    expect(alertSummary(h.issues)).toBe("1 台連不上、影像解碼改用處理器");
  });
});
