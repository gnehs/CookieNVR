import { useSyncExternalStore } from "react";

/** 跟著 media query 變的布林值 */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => matchMedia(query).matches,
  );
}

/** 全站的手機斷點：對話框、選單在這個寬度以下變成底部面板（同 CSS 的 max-width: 560px） */
export const PHONE = "(max-width: 560px)";
/** Select、日曆這類浮動清單變成底部面板的條件（同 ui/popup.css）：窄螢幕，或橫拿的手機 */
export const SHEET_POPUP = "(max-width: 560px), (pointer: coarse) and (max-height: 500px)";
