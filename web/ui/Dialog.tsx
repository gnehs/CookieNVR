import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Dialog as Base } from "@base-ui/react/dialog";
import { Drawer } from "@base-ui/react/drawer";
import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { PHONE, useMedia } from "./useMedia.ts";
import { useRetained } from "./use-retained.ts";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children?: ReactNode;
  /** 打開時要聚焦的元素；預設是第一個可聚焦的元素 */
  initialFocus?: RefObject<HTMLElement | null>;
  /** 關閉動畫播完、內容移除之後 */
  onClosed?: () => void;
  /**
   * 有還沒儲存的變更：Esc、點外面、往下拉、<DialogClose> 都先問要不要放棄。
   * "busy" 是正在送出，這段期間不能關。
   */
  guard?: false | "dirty" | "busy";
  /** 固定在底部的動作列；有它時 children 在中間捲動，標題與動作列不動 */
  footer?: ReactNode;
  /** 桌面上較寬（放得下畫面預覽）；手機上是全高的面板 */
  wide?: boolean;
}

// Safari 與 iOS 點按鈕時按鈕不會取得焦點，Base UI 就不知道關閉後要回到哪；自己記住最後被點的按鈕
let lastPressed: { el: HTMLElement; at: number } | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "click",
    (e) => {
      const el = e.target instanceof Element ? e.target.closest<HTMLElement>("button, a[href]") : null;
      lastPressed = el ? { el, at: performance.now() } : null;
    },
    true,
  );
}

const CloseContext = createContext<() => void>(() => {});

/** 對話框裡的「取消」：和 Esc、點外面走同一條路，有未儲存的變更時一樣會先問 */
export function DialogClose({ className = "btn", disabled, children }: { className?: string; disabled?: boolean; children: ReactNode }) {
  const close = useContext(CloseContext);
  return (
    <button className={className} type="button" disabled={disabled} onClick={close}>
      {children}
    </button>
  );
}

const askDiscard = () =>
  confirmDialog(t`Discard these changes?`, t`You haven't saved your recent edits. Closing will discard them.`, {
    confirmLabel: t`Discard changes`,
    cancelLabel: t`Keep editing`,
    danger: true,
  });

/**
 * 對話框：桌面置中（Base UI Dialog）；手機是從下方滑出的面板（Base UI Drawer），可以按住往下拉關閉，
 * 內容捲到頂端後再往下拉才會拖動面板。手機開鍵盤時面板跟著往上移（iOS 開鍵盤只縮 visualViewport，不會推動 fixed 的元素）。
 */
export function Dialog({ open, onOpenChange, title, children, initialFocus, onClosed, guard = false, footer, wide }: DialogProps) {
  const sheet = useMedia(PHONE);
  const popup = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const guardRef = useRef(guard);
  guardRef.current = guard;
  const asking = useRef(false);
  if (open && !wasOpen.current) {
    const a = document.activeElement;
    const pressed = lastPressed && performance.now() - lastPressed.at < 1000 ? lastPressed.el : null;
    opener.current = pressed ?? (a instanceof HTMLElement && a !== document.body ? a : null);
  }
  wasOpen.current = open;

  useEffect(() => {
    const vv = window.visualViewport;
    if (!open || !vv) return;
    const avoidKeyboard = () => {
      const kb = Math.max(0, innerHeight - vv.height - vv.offsetTop);
      popup.current?.style.setProperty("--kb", `${Math.round(kb)}px`);
    };
    vv.addEventListener("resize", avoidKeyboard);
    vv.addEventListener("scroll", avoidKeyboard);
    return () => {
      vv.removeEventListener("resize", avoidKeyboard);
      vv.removeEventListener("scroll", avoidKeyboard);
    };
  }, [open]);

  const requestClose = () => {
    const g = guardRef.current;
    if (g === "busy" || asking.current) return;
    if (g !== "dirty") return onOpenChange(false);
    asking.current = true;
    void askDiscard().then((ok) => {
      asking.current = false;
      if (ok) onOpenChange(false);
    });
  };
  const change = (next: boolean, details: { cancel: () => void }) => {
    if (next) return onOpenChange(true);
    // 交給 requestClose 決定；先擋下這次關閉，面板會彈回原位
    if (guardRef.current) details.cancel();
    requestClose();
  };
  const finalFocus = () => (opener.current?.isConnected ? opener.current : true);
  const cls = `${sheet ? "sheet" : "dlg"}${footer ? " has-foot" : ""}${wide ? " wide" : ""}`;
  const body = footer ? (
    <>
      <div className="dlg-body scroll-fade">{children}</div>
      <div className="dlg-foot">{footer}</div>
    </>
  ) : (
    children
  );

  if (sheet) {
    return (
      <CloseContext.Provider value={requestClose}>
        <Drawer.Root open={open} onOpenChange={change} onOpenChangeComplete={(next) => !next && onClosed?.()} swipeDirection="down">
          <Drawer.Portal>
            <Drawer.Backdrop className="dlg-backdrop swipeable" />
            <Drawer.Viewport className="sheet-viewport">
              <Drawer.Popup ref={popup} className={cls} initialFocus={initialFocus} finalFocus={finalFocus}>
                <div className="sheet-grip" aria-hidden="true" />
                <Drawer.Title className="dlg-title">{title}</Drawer.Title>
                <Drawer.Content className="sheet-content">{body}</Drawer.Content>
              </Drawer.Popup>
            </Drawer.Viewport>
          </Drawer.Portal>
        </Drawer.Root>
      </CloseContext.Provider>
    );
  }
  return (
    <CloseContext.Provider value={requestClose}>
      <Base.Root open={open} onOpenChange={change} onOpenChangeComplete={(next) => !next && onClosed?.()}>
        <Base.Portal>
          <Base.Backdrop className="dlg-backdrop" />
          <Base.Popup ref={popup} className={cls} initialFocus={initialFocus} finalFocus={finalFocus}>
            <Base.Title className="dlg-title">{title}</Base.Title>
            {body}
          </Base.Popup>
        </Base.Portal>
      </Base.Root>
    </CloseContext.Provider>
  );
}

interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

// 確認對話框是「問一句、等答案」的流程，用 Promise 比把開關狀態放進每個頁面直接；畫面由根元件的 <ConfirmHost> 負責
let pending: ConfirmRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

/** `if (await confirmDialog("刪除攝影機？", "…", { danger: true, confirmLabel: "刪除" })) …` */
export function confirmDialog(title: string, message: string, opts: { confirmLabel?: string; cancelLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  pending?.resolve(false);
  return new Promise((resolve) => {
    pending = { title, message, ...opts, resolve };
    emit();
  });
}

export function ConfirmHost() {
  const { t } = useLingui();
  const req = useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => pending,
  );
  // 關閉動畫期間保留最後一次的內容
  const [shown, clearShown] = useRetained(req);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const answer = (ok: boolean) => {
    if (!req) return;
    pending = null;
    req.resolve(ok);
    emit();
  };
  return (
    <Dialog open={req !== null} onOpenChange={(o) => !o && answer(false)} title={shown?.title ?? ""} initialFocus={confirmBtn} onClosed={clearShown}>
      <p className="dlg-text">{shown?.message}</p>
      <div className="dlg-actions">
        <button className="btn" type="button" onClick={() => answer(false)}>
          {shown?.cancelLabel ?? t`Cancel`}
        </button>
        <button ref={confirmBtn} className={`btn ${shown?.danger ? "danger solid" : "primary"}`} type="button" onClick={() => answer(true)}>
          {shown?.confirmLabel ?? t`OK`}
        </button>
      </div>
    </Dialog>
  );
}
