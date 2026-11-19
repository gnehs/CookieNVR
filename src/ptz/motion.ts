/** 停止後這段時間內仍視為「鏡頭剛動過」，畫面還在晃 */
export const SETTLE_MS = 3_000;

/**
 * 每台鏡頭「現在是否在移動，或剛停止不到 3 秒」。動作偵測用它暫停偵測。
 * 持續移動沒有明確的結束時間：下一次移動、手動停止或安全停止。所以持續移動記成
 * 「最晚在安全停止送出後再過 SETTLE_MS」，收到手動停止就改成「現在起 SETTLE_MS」。
 */
export class MotionTracker {
  private readonly busyUntil = new Map<string, number>();

  constructor(
    private readonly now: () => number,
    private readonly idleStopMs: number,
  ) {}

  continuousMove(id: string): void {
    this.busyUntil.set(id, this.now() + this.idleStopMs + SETTLE_MS);
  }

  /** 相對移動、前往預置點、手動停止：指令送出後鏡頭還會動一下 */
  settle(id: string): void {
    this.busyUntil.set(id, this.now() + SETTLE_MS);
  }

  isBusy(id: string): boolean {
    const until = this.busyUntil.get(id);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.busyUntil.delete(id);
    return false;
  }

  forget(id: string): void {
    this.busyUntil.delete(id);
  }
}
