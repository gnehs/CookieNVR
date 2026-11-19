import type { WorkerStatus } from "../types.ts";

/** 同一個 worker 的同一則失敗，這段時間內只印一次：重啟迴圈不會洗版，問題持續時仍看得到 */
export const REPEAT_MS = 10 * 60_000;

/**
 * 把 worker 進入退避的那一刻換成一行容器日誌，讓只看 `docker logs`（例如 Unraid 的 Logs 視窗）的人
 * 也知道哪個服務停了、為什麼。`explain` 可以把已知的錯誤換成白話的改法。
 */
export function createFailureLog(opts: {
  print: (line: string) => void;
  /** 輸出尾端送出前的遮蔽（串流網址裡有帳密） */
  redact: (line: string) => string;
  explain?: (status: WorkerStatus, lastLine: string) => string | null;
  now?: () => number;
}): (status: WorkerStatus) => void {
  const now = opts.now ?? Date.now;
  const logged = new Map<string, { message: string; at: number }>();
  return (status) => {
    if (status.state !== "backoff") return;
    const lastLine = opts.redact(causeLine(status.stderrTail));
    const code = status.lastRestart?.exitCode;
    const message =
      opts.explain?.(status, lastLine) ??
      `[worker] ${status.id} 停止了${code === null || code === undefined ? "" : `（結束碼 ${code}）`}，稍後自動重新啟動${lastLine ? `：${lastLine}` : ""}`;
    const prev = logged.get(status.id);
    if (prev && prev.message === message && now() - prev.at < REPEAT_MS) return;
    logged.set(status.id, { message, at: now() });
    opts.print(message);
  };
}

/** ffmpeg 收尾時印的籠統訊息，真正的原因在它前面 */
const GENERIC = [/Nothing was written into output file/, /Terminating thread with return code/, /Task finished with error code/, /Conversion failed/];
/** 一眼看得出原因的錯誤 */
const TELLING = /Permission denied|No such file or directory|No space left|Read-only file system|Server returned|Connection refused|timed out|Invalid data|not supported/i;

/** 挑最能說明原因的一行：最後一行明確的錯誤，否則最後一行不是一般訊息、也不是收尾套話的 */
export function causeLine(tail: readonly string[]): string {
  const lines = tail.filter((l) => l.trim() !== "" && !/\bINF\b/.test(l));
  return (
    lines.findLast((l) => TELLING.test(l) && !GENERIC.some((g) => g.test(l))) ??
    lines.findLast((l) => !GENERIC.some((g) => g.test(l))) ??
    lines.at(-1) ??
    tail.at(-1) ??
    ""
  );
}
