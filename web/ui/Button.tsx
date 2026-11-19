import { createLink } from "@tanstack/react-router";
import { forwardRef, useRef, useState, type ButtonHTMLAttributes, type AnchorHTMLAttributes } from "react";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.ts";
import { toast } from "./toast.tsx";

export type ButtonVariant = "primary" | "danger" | "danger solid" | "ghost";

interface Look {
  variant?: ButtonVariant;
  small?: boolean;
  /** 只有圖示的按鈕：一定要給 aria-label */
  iconOnly?: boolean;
  icon?: IconName;
  iconSize?: number;
}

function cls({ variant, small, iconOnly }: Look, extra?: string): string {
  return ["btn", variant, small && "small", iconOnly && "icon-only", extra].filter(Boolean).join(" ");
}

/** `.btn` 按鈕；變體就是 style.css 裡的 class：primary、danger、danger solid、ghost，加上 small、icon-only */
export function Button({ variant, small, iconOnly, icon, iconSize = 16, className, type = "button", children, ...rest }: Look & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={cls({ variant, small, iconOnly }, className)} {...rest}>
      {icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
    </button>
  );
}

const BtnAnchor = forwardRef<HTMLAnchorElement, Look & AnchorHTMLAttributes<HTMLAnchorElement>>(function BtnAnchor(
  { variant, small, iconOnly, icon, iconSize = 16, className, children, ...rest },
  ref,
) {
  return (
    <a ref={ref} className={cls({ variant, small, iconOnly }, className)} {...rest}>
      {icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
    </a>
  );
});

/** 長得像按鈕的站內連結：`<ButtonLink to="/settings/cameras/new" variant="primary" icon="plus">` */
export const ButtonLink = createLink(BtnAnchor);

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  // LAN 以 http 存取時沒有 Clipboard API，退回選取後 execCommand
  const ta = document.createElement("textarea");
  ta.className = "sr-only";
  ta.readOnly = true;
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  ta.remove();
  return ok;
}

export async function copyWithToast(text: string, label: string) {
  if (await copyText(text)) toast(`已複製${label}`);
  else toast("無法複製，請手動選取", "error");
}

/**
 * 複製按鈕：按下後在按鈕上換成打勾與「已複製」，同時用 toast 告知。
 * 不在回饋期間停用按鈕，失敗後可以直接再按一次。
 */
export function CopyButton({ label, getText, done, className, ariaLabel }: { label: string; getText: () => string | Promise<string>; done?: string; className?: string; ariaLabel?: string }) {
  const [state, setState] = useState<"done" | "failed" | null>(null);
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onClick = async () => {
    if (busy.current) return;
    busy.current = true;
    let ok = false;
    const pending = Promise.resolve().then(getText);
    try {
      // 內容要等網路回來時，Safari 只接受在點擊當下交出 ClipboardItem（內容可以是之後才完成的 Promise）
      if (window.isSecureContext && "ClipboardItem" in window && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": pending.then((t) => new Blob([t], { type: "text/plain" })) })]);
        ok = true;
      }
    } catch {}
    if (!ok) {
      try {
        ok = await copyText(await pending);
      } catch {}
    }
    busy.current = false;
    clearTimeout(timer.current);
    setState(ok ? "done" : "failed");
    toast(ok ? (done ?? "已複製") : "無法複製，請再試一次", ok ? "ok" : "error");
    timer.current = setTimeout(() => setState(null), 2200);
  };
  return (
    <button type="button" className={`btn copy-btn${className ? ` ${className}` : ""}`} aria-label={ariaLabel} data-state={state ?? undefined} onClick={onClick}>
      <span className="copy-face" key={state ?? "idle"}>
        <Icon name={state === "done" ? "check" : state === "failed" ? "alert" : "copy"} size={16} />
        <span>{state === "done" ? "已複製" : state === "failed" ? "複製失敗" : label}</span>
      </span>
    </button>
  );
}
