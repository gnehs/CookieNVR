import { expect, test } from "bun:test";
import type { WorkerStatus } from "../types.ts";
import { causeLine, createFailureLog, createRepeatLog, REPEAT_MS } from "./failure-log.ts";

const status = (o: Partial<WorkerStatus>): WorkerStatus => ({
  id: "restream",
  kind: "restream",
  state: "backoff",
  unstable: false,
  pid: null,
  startedAt: null,
  restarts: 1,
  lastRestart: { reason: "exit", at: 0, exitCode: 1 },
  stderrTail: [],
  ...o,
});

test("進入退避時印出哪個服務停了，用最後一行錯誤而不是一般訊息", () => {
  const lines: string[] = [];
  const log = createFailureLog({ print: (l) => lines.push(l), redact: (l) => l });
  log(status({ stderrTail: ["INF configuration loaded", "ERR something broke", "INF waiting for running hooks"] }));
  expect(lines).toEqual(["[worker] restream 停止了（結束碼 1），稍後自動重新啟動：ERR something broke"]);
});

test("重啟迴圈裡同樣的錯誤只印一次，過了一段時間或錯誤變了才再印", () => {
  let t = 0;
  const lines: string[] = [];
  const log = createFailureLog({ print: (l) => lines.push(l), redact: (l) => l, now: () => t });
  const broken = status({ stderrTail: ["ERR a"] });
  log(broken);
  log(status({ state: "running" }));
  t = 30_000;
  log(broken);
  expect(lines).toHaveLength(1);
  log(status({ stderrTail: ["ERR b"] }));
  expect(lines).toHaveLength(2);
  t += REPEAT_MS;
  log(status({ stderrTail: ["ERR b"] }));
  expect(lines).toHaveLength(3);
});

test("輸出先遮蔽再印；已知的錯誤換成白話的改法", () => {
  const lines: string[] = [];
  const log = createFailureLog({
    print: (l) => lines.push(l),
    redact: (l) => l.replace("secret", "***"),
    explain: (_s, last) => (last.includes("address already in use") ? "port 被佔用" : null),
  });
  log(status({ id: "record:a", kind: "record", stderrTail: ["rtsp://u:secret@h failed"] }));
  log(status({ stderrTail: ["ERR listen tcp :8554: bind: address already in use"] }));
  expect(lines).toEqual(["[worker] record:a 停止了（結束碼 1），稍後自動重新啟動：rtsp://u:***@h failed", "port 被佔用"]);
});

test("ffmpeg 收尾的套話不算原因，挑前面真正的錯誤（容器內以 uid 99 寫入 root 資料夾的實際輸出）", () => {
  const tail = [
    "[out#0/segment @ 0xae161198f680] Could not write header (incorrect codec parameters ?): Permission denied",
    "[vf#0:0 @ 0xae1611990e10] Error sending frames to consumers: Permission denied",
    "[vf#0:0 @ 0xae1611990e10] Task finished with error code: -13 (Permission denied)",
    "[vf#0:0 @ 0xae1611990e10] Terminating thread with return code -13 (Permission denied)",
    "[out#0/segment @ 0xae161198f680] Nothing was written into output file, because at least one of its streams received no packets.",
  ];
  expect(causeLine(tail)).toBe(tail[1]!);
  expect(causeLine(["Error opening input files: Server returned 400 Bad Request"])).toContain("400");
  expect(causeLine(["INF only info"])).toBe("INF only info");
});

test("同一則錯誤一段時間內只印一次；每則都不同的錯誤不會讓記住的訊息無限增加", () => {
  let t = 0;
  const lines: string[] = [];
  const log = createRepeatLog((l) => lines.push(l), () => t);
  log("index", new Error("disk full"));
  log("index", new Error("disk full"));
  expect(lines).toEqual(["[index] disk full"]);
  t += REPEAT_MS;
  log("index", "disk full");
  expect(lines).toHaveLength(2);

  for (let i = 0; i < 5_000; i++) log("objects", `frame ${i}`);
  // 記住的訊息被清過：最早那則在期限內又印得出來
  log("objects", "frame 0");
  expect(lines.filter((l) => l === "[objects] frame 0")).toHaveLength(2);
});
