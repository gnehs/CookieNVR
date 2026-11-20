import { Fragment, type ReactNode } from "react";

/** 一個按鍵的鍵帽，例如 <Kbd>空白鍵</Kbd>、<Kbd>←</Kbd> */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export interface KeyHint {
  /** 這個操作的按鍵，依序並排，例如 ["←", "→"] */
  keys: string[];
  label: string;
}

/**
 * 一行鍵盤快速鍵說明：「[空白鍵] 播放／暫停 · [←][→] 前後 10 秒」。
 * 觸控裝置沒有實體鍵盤，預設隱藏（hover: none）；要一直顯示時傳 always。
 */
export function KeyHints({ hints, className, id, always }: { hints: KeyHint[]; className?: string; id?: string; always?: boolean }) {
  return (
    <p className={["key-hints", always ? "" : "key-hints-fine", className].filter(Boolean).join(" ")} id={id}>
      {hints.map((h, i) => (
        <Fragment key={h.label}>
          {i > 0 ? <span className="key-hints-sep" aria-hidden="true" /> : null}
          <span className="key-hint">
            <span className="key-hint-keys">
              {h.keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
            {h.label}
          </span>
        </Fragment>
      ))}
    </p>
  );
}
