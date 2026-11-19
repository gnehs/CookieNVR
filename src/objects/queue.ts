/** 排隊超過這麼久的畫面直接丟掉，不累積延遲（規格：1 秒） */
export const MAX_QUEUE_AGE_MS = 1_000;
/** 防止 detector 很慢時佇列無限長；正常情況下 1 秒的期限會先生效 */
export const MAX_QUEUE_LENGTH = 32;

/**
 * 等待推論的畫面。先進先出；取出時把排隊超過期限的丟掉並計數。
 * 所有攝影機共用一條，detector 一次只處理一張。
 */
export class FrameQueue<T> {
  private items: { at: number; value: T }[] = [];
  dropped = 0;

  constructor(
    private readonly maxAgeMs = MAX_QUEUE_AGE_MS,
    private readonly maxLength = MAX_QUEUE_LENGTH,
  ) {}

  push(value: T, at: number): void {
    this.items.push({ at, value });
    while (this.items.length > this.maxLength) {
      this.items.shift();
      this.dropped++;
    }
  }

  /** 最舊的一張還沒過期的畫面；沒有就回 null */
  take(now: number): T | null {
    for (;;) {
      const head = this.items.shift();
      if (!head) return null;
      if (now - head.at <= this.maxAgeMs) return head.value;
      this.dropped++;
    }
  }

  get length(): number {
    return this.items.length;
  }

  /** detector 斷線時清空；這些不算丟掉的畫面 */
  clear(): void {
    this.items = [];
  }
}
