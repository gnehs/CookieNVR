import { useRef } from "react";

/** 在快取清單裡找符合的那一筆；刪除後快取已經沒有它但還沒換頁時，回傳上一次找到的，避免閃一下「找不到」 */
export function useRetainedItem<T>(list: readonly T[] | undefined, match: (item: T) => boolean): T | undefined {
  const last = useRef<T | undefined>(undefined);
  const hit = list?.find(match);
  if (hit) last.current = hit;
  return hit ?? (last.current && match(last.current) ? last.current : undefined);
}
