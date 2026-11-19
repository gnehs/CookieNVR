import { expect, test } from "bun:test";
import type { WorkerStatus } from "../types.ts";
import { createFailureLog, REPEAT_MS } from "./failure-log.ts";

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
