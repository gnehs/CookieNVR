import { nextId } from "../dom.ts";

/**
 * 對齊觸發按鈕的彈出層：放在 top layer（Popover API），不會被父層的 overflow 裁掉；點外面、Esc 關閉都是瀏覽器內建的。
 * 位置優先交給 CSS anchor positioning（空間不夠時自動翻到上方）；不支援的瀏覽器用 JS 量位置，捲動與縮放時跟著更新。
 * 手機（窄螢幕或橫拿的手機）由 CSS 改成底部面板，這裡不定位。
 */
export const SHEET_MQ = "(max-width: 560px), (pointer: coarse) and (max-height: 500px)";
const GAP = 6;
const EDGE = 8;

export const anchorSupported = typeof CSS !== "undefined" && CSS.supports("position-area: block-end") && CSS.supports("anchor-name: --a");

export interface Popup {
  open(how: "pointer" | "keyboard"): void;
  close(restoreFocus?: boolean): void;
  readonly isOpen: boolean;
  /** 底部面板模式（手機） */
  readonly sheet: boolean;
  /** 觸發按鈕的 click 要不要開啟：按下按鈕的那一刻，瀏覽器已經把開著的彈出層當成點外面關掉了 */
  shouldOpenOnClick(): boolean;
}

export function anchoredPopup(trigger: HTMLElement, el: HTMLElement, hooks: { onOpen?: () => void; onClose?: () => void } = {}): Popup {
  el.setAttribute("popover", "auto");
  el.classList.add("popup");
  const sheetMq = matchMedia(SHEET_MQ);
  let isOpen = false;
  let restore = true;
  let raf = 0;
  let openAtPress = false;
  trigger.addEventListener("pointerdown", () => (openAtPress = isOpen), { capture: true });

  if (anchorSupported) {
    const name = `--${nextId("anchor")}`;
    trigger.style.setProperty("anchor-name", name);
    el.style.setProperty("position-anchor", name);
    el.dataset.anchored = "";
  }

  /** 沒有 anchor positioning 時的退路：跟 CSS 版一樣先放下方、左邊對齊，放不下就翻到上方或限制高度 */
  const place = () => {
    raf = 0;
    if (!isOpen || sheetMq.matches) return;
    const r = trigger.getBoundingClientRect();
    // 按鈕捲出畫面就收起來，不讓彈出層浮在不相干的地方
    if (r.bottom < 0 || r.top > innerHeight) {
      restore = false;
      el.hidePopover();
      return;
    }
    // 上下兩側較大的那一側放得下多高；CSS 先放下方，放不下才翻到上方，兩邊都放不下時在較大的一側捲動
    el.style.setProperty("--popup-room", `${Math.floor(Math.max(120, innerHeight - r.bottom, r.top) - GAP - EDGE)}px`);
    if (!anchorSupported) {
      el.style.minWidth = `${Math.round(r.width)}px`;
      el.style.maxHeight = "";
      const natural = el.scrollHeight + (el.offsetHeight - el.clientHeight);
      const below = innerHeight - r.bottom - GAP - EDGE;
      const above = r.top - GAP - EDGE;
      const down = natural <= below || below >= above;
      const room = Math.max(120, down ? below : above);
      el.style.maxHeight = `${Math.floor(room)}px`;
      const h = Math.min(natural, room);
      const w = el.offsetWidth;
      const left = r.left + w <= innerWidth - EDGE ? r.left : r.right - w;
      el.style.left = `${Math.round(Math.max(EDGE, Math.min(innerWidth - w - EDGE, left)))}px`;
      el.style.top = `${Math.round(down ? r.bottom + GAP : Math.max(EDGE, r.top - GAP - h))}px`;
    }
    // 依實際翻到哪一側決定縮放的原點，讓彈出層從按鈕長出來
    const p = el.getBoundingClientRect();
    el.dataset.side = p.top >= r.top ? "bottom" : "top";
    el.dataset.align = Math.abs(p.left - r.left) <= Math.abs(p.right - r.right) ? "start" : "end";
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(place);
  };

  el.addEventListener("toggle", (e) => {
    const open = (e as ToggleEvent).newState === "open";
    isOpen = open;
    trigger.setAttribute("aria-expanded", String(open));
    trigger.toggleAttribute("data-popup-open", open);
    if (open) {
      addEventListener("scroll", schedule, { capture: true, passive: true });
      addEventListener("resize", schedule);
      return;
    }
    removeEventListener("scroll", schedule, { capture: true });
    removeEventListener("resize", schedule);
    cancelAnimationFrame(raf);
    raf = 0;
    const focusInside = el.contains(document.activeElement) || document.activeElement === document.body;
    if (restore && focusInside) trigger.focus({ preventScroll: true });
    restore = true;
    hooks.onClose?.();
  });
  // Tab 移出彈出層時關閉；移回觸發按鈕不算
  el.addEventListener("focusout", (e) => {
    const to = e.relatedTarget as Node | null;
    if (isOpen && to && !el.contains(to) && to !== trigger) {
      restore = false;
      el.hidePopover();
    }
  });

  return {
    open(how) {
      if (isOpen) return;
      el.toggleAttribute("data-instant", how === "keyboard");
      el.showPopover();
      isOpen = true;
      place();
      hooks.onOpen?.();
    },
    close(restoreFocus = true) {
      if (!isOpen) return;
      restore = restoreFocus;
      el.hidePopover();
    },
    get isOpen() {
      return isOpen;
    },
    shouldOpenOnClick() {
      const was = openAtPress;
      openAtPress = false;
      return !was && !isOpen;
    },
    get sheet() {
      return sheetMq.matches;
    },
  };
}
