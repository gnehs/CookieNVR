import { Dialog as Base } from "@base-ui/react/dialog";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children?: ReactNode;
  /** 打開時要聚焦的元素；預設是第一個可聚焦的元素 */
  initialFocus?: RefObject<HTMLElement | null>;
  /** 關閉動畫播完、內容移除之後 */
  onClosed?: () => void;
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

/**
 * 對話框（Base UI Dialog）：桌面置中，手機是底部面板；Esc 與點背景都會關閉。
 * 手機開鍵盤時面板跟著往上移（iOS 開鍵盤只縮 visualViewport，不會推動 fixed 的元素）。
 */
export function Dialog({ open, onOpenChange, title, children, initialFocus, onClosed }: DialogProps) {
  const popup = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
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
  return (
    <Base.Root open={open} onOpenChange={(next) => onOpenChange(next)} onOpenChangeComplete={(next) => !next && onClosed?.()}>
      <Base.Portal>
        <Base.Backdrop className="dlg-backdrop" />
        <Base.Popup ref={popup} className="dlg" initialFocus={initialFocus} finalFocus={() => (opener.current?.isConnected ? opener.current : true)}>
          <Base.Title>{title}</Base.Title>
          {children}
        </Base.Popup>
      </Base.Portal>
    </Base.Root>
  );
}

interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

// 確認對話框是「問一句、等答案」的流程，用 Promise 比把開關狀態放進每個頁面直接；畫面由根元件的 <ConfirmHost> 負責
let pending: ConfirmRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

/** `if (await confirmDialog("刪除攝影機？", "…", { danger: true, confirmLabel: "刪除" })) …` */
export function confirmDialog(title: string, message: string, opts: { confirmLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  pending?.resolve(false);
  return new Promise((resolve) => {
    pending = { title, message, ...opts, resolve };
    emit();
  });
}

export function ConfirmHost() {
  const req = useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => pending,
  );
  // 關閉動畫期間保留最後一次的內容
  const [shown, setShown] = useState<ConfirmRequest | null>(null);
  if (req && req !== shown) setShown(req);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const answer = (ok: boolean) => {
    if (!req) return;
    pending = null;
    req.resolve(ok);
    emit();
  };
  return (
    <Dialog open={req !== null} onOpenChange={(o) => !o && answer(false)} title={shown?.title ?? ""} initialFocus={confirmBtn} onClosed={() => setShown(null)}>
      <p className="dlg-text">{shown?.message}</p>
      <div className="dlg-actions">
        <button className="btn" type="button" onClick={() => answer(false)}>
          取消
        </button>
        <button ref={confirmBtn} className={`btn ${shown?.danger ? "danger solid" : "primary"}`} type="button" onClick={() => answer(true)}>
          {shown?.confirmLabel ?? "確定"}
        </button>
      </div>
    </Dialog>
  );
}
