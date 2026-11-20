import { useCallback, useRef } from "react";

/**
 * 底部面板的下滑關閉，手感照 vaul（https://vaul.emilkowal.ski/）：
 * 按住面板往下拉會跟著手指，遮罩跟著變淡；往上拉有阻力；
 * 放開時拉超過面板高度的 25%，或甩的速度超過 0.4 px/ms 就關閉，否則彈回原位。
 * 面板裡的內容還沒捲到頂時，往下滑先捲內容，捲到頂之後的下一次滑動才拖面板。
 *
 * Base UI 的 Dialog 已經用 Drawer 做到這件事；這裡給 Select、Menu、Popover 這些
 * 只在手機上由 CSS 變成底部面板的浮動層用。
 */

const CLOSE_RATIO = 0.25;
const VELOCITY = 0.4;
/** 手指移動超過這麼多才決定這次是拖面板還是捲內容 */
const SLOP = 4;
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const SETTLE_MS = 500;

/** 往上拉的阻力：越拉越拉不動（同 vaul 的 dampenValue） */
const dampen = (v: number) => 8 * (Math.log(v + 1) - 2);

/** 從手指下的元素往上到面板，有沒有哪一層還沒捲到頂 */
function scrolledAbove(target: EventTarget | null, sheet: HTMLElement): boolean {
  for (let n = target instanceof Element ? target : null; n; n = n.parentElement) {
    if (n.scrollTop > 0 && n.scrollHeight > n.clientHeight) return true;
    if (n === sheet) break;
  }
  return false;
}

/**
 * 回傳給 Popup 的 ref callback。query 是面板變成底部面板的 media query，
 * 不符合（桌面的浮動清單）時不攔任何觸控；onDismiss 要把浮動層關掉（受控的 open）。
 */
export function sheetSwipe(query: string, onDismiss: () => void) {
  return (sheet: HTMLElement | null) => {
    if (!sheet) return;
    // 遮罩跟 Positioner 是同一層的兄弟（中間可能夾著 Base UI 的焦點守衛）
    const backdrop = () => sheet.parentElement?.parentElement?.querySelector<HTMLElement>(":scope > .sheet-backdrop") ?? null;
    const paint = (y: number, height: number, animate: boolean) => {
      const transition = animate ? `transform ${SETTLE_MS}ms ${EASE}` : "none";
      sheet.style.transition = transition;
      sheet.style.transform = y ? `translateY(${y}px)` : "";
      const bd = backdrop();
      if (bd) {
        bd.style.transition = animate ? `opacity ${SETTLE_MS}ms ${EASE}` : "none";
        bd.style.opacity = y > 0 ? String(Math.max(0, 1 - y / height)) : "";
      }
    };

    let startY = 0;
    let startT = 0;
    let lastY = 0;
    let height = 0;
    /** null：還沒決定；true：這次在拖面板；false：這次交給內容捲動 */
    let dragging: boolean | null = null;

    const onStart = (e: TouchEvent) => {
      dragging = e.touches.length === 1 && matchMedia(query).matches ? null : false;
      if (dragging === false) return;
      startY = lastY = e.touches[0]!.clientY;
      startT = performance.now();
      height = sheet.getBoundingClientRect().height;
    };
    const onMove = (e: TouchEvent) => {
      if (dragging === false) return;
      const y = e.touches[0]!.clientY;
      if (dragging === null) {
        if (Math.abs(y - startY) < SLOP) return;
        dragging = y > startY && !scrolledAbove(e.target, sheet);
        if (!dragging) return;
        // 從這裡開始算，面板不會一下子跳過容許的那幾 px
        startY = y;
        startT = performance.now();
      }
      e.preventDefault();
      lastY = y;
      const d = y - startY;
      paint(d >= 0 ? d : dampen(-d) * -1, height, false);
    };
    const onEnd = () => {
      if (dragging !== true) return;
      dragging = null;
      const d = lastY - startY;
      const velocity = d / Math.max(1, performance.now() - startT);
      if (d > height * CLOSE_RATIO || (d > 0 && velocity > VELOCITY)) {
        // 從手指放開的位置接著滑出去；Base UI 會等這段動畫跑完才卸載
        paint(height, height, true);
        onDismiss();
        // 有些浮動層關閉後元素還留著，下次打開要回到原位
        setTimeout(() => paint(0, height, false), SETTLE_MS + 50);
      } else {
        paint(0, height, true);
      }
    };

    sheet.addEventListener("touchstart", onStart, { passive: true });
    sheet.addEventListener("touchmove", onMove, { passive: false });
    sheet.addEventListener("touchend", onEnd);
    sheet.addEventListener("touchcancel", onEnd);
    return () => {
      sheet.removeEventListener("touchstart", onStart);
      sheet.removeEventListener("touchmove", onMove);
      sheet.removeEventListener("touchend", onEnd);
      sheet.removeEventListener("touchcancel", onEnd);
    };
  };
}

/** sheetSwipe 的 hook 版：ref callback 固定不變，重畫時不會拆掉正在拖的手勢 */
export function useSheetSwipe(query: string, onDismiss: () => void) {
  const latest = useRef(onDismiss);
  latest.current = onDismiss;
  return useCallback((sheet: HTMLElement | null) => sheetSwipe(query, () => latest.current())(sheet), [query]);
}
