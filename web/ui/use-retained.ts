import { useState } from "react";

/**
 * 對話框關閉的動畫期間，內容的來源（例如「正在編輯誰」）已經是 null，畫面還要留著最後一次的內容。
 * 回傳最後一個非空的值，以及動畫結束時（Dialog 的 onClosed）用來清掉它的函式。
 */
export function useRetained<T>(value: T | null): [T | null, () => void] {
  const [shown, setShown] = useState<T | null>(null);
  if (value && value !== shown) setShown(value);
  return [shown, () => setShown(null)];
}
