import { Menu as Base } from "@base-ui/react/menu";
import { Link, type LinkProps } from "@tanstack/react-router";
import { type ReactElement, useRef } from "react";
import { Icon } from "./Icon.tsx";
import { moveIndicator } from "./indicator.ts";
import type { IconName } from "./icons.ts";

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  /** 有 to 的項目是站內連結；沒有的是按鈕，選了呼叫 onSelect */
  to?: LinkProps["to"];
  params?: LinkProps["params"];
  current?: boolean;
  /** 項目右邊的數字或提示（例如問題數） */
  badge?: string;
  badgeLabel?: string;
  onSelect?: () => void;
}

export type MenuEntry = MenuItem | null | false;

function ItemBody({ it }: { it: MenuItem }) {
  return (
    <>
      {it.icon ? <Icon name={it.icon} size={16} /> : null}
      <span className="menu-label">{it.label}</span>
      {it.badge ? (
        <span className="menu-count" aria-label={it.badgeLabel}>
          {it.badge}
        </span>
      ) : null}
    </>
  );
}

function Item({ it }: { it: MenuItem }) {
  const cls = `menu-item${it.danger ? " danger" : ""}`;
  if (it.to) {
    return (
      <Base.LinkItem className={cls} aria-current={it.current ? "page" : undefined} closeOnClick render={<Link to={it.to} params={it.params} />}>
        <ItemBody it={it} />
      </Base.LinkItem>
    );
  }
  return (
    <Base.Item className={cls} onClick={it.onSelect}>
      <ItemBody it={it} />
    </Base.Item>
  );
}

/**
 * 一塊高亮底色跟著 Base UI 標的 data-highlighted（滑鼠或方向鍵）在項目間滑動；
 * 高亮由 Base UI 管，所以盯著屬性變化，而不是跟著 React 的 state。
 */
function useHighlightBlock() {
  const block = useRef<HTMLDivElement>(null);
  const popupRef = (popup: HTMLDivElement | null) => {
    if (!popup) return;
    const sync = () => {
      const b = block.current;
      if (!b) return;
      const it = popup.querySelector<HTMLElement>(".menu-item[data-highlighted]");
      moveIndicator(b, it);
      b.toggleAttribute("data-danger", !!it?.classList.contains("danger"));
    };
    const mo = new MutationObserver(sync);
    mo.observe(popup, { subtree: true, attributes: true, attributeFilter: ["data-highlighted"] });
    sync();
    return () => mo.disconnect();
  };
  return { block, popupRef };
}

/**
 * 觸發按鈕＋選單（Base UI Menu）：方向鍵在項目間移動，Esc 與點外面關閉並把焦點還給按鈕。
 * 桌面浮在按鈕旁，手機由 CSS 改成底部面板，面板頂端顯示 label。
 */
export function Menu({ trigger, label, entries, align = "end", side = "bottom" }: { trigger: ReactElement; label: string; entries: MenuEntry[]; align?: "start" | "end"; side?: "bottom" | "top" }) {
  const { block, popupRef } = useHighlightBlock();
  return (
    <Base.Root>
      <Base.Trigger render={trigger} />
      <Base.Portal>
        <Base.Backdrop className="sheet-backdrop" data-sheet="menu" />
        <Base.Positioner className="menu-pos" side={side} align={align} sideOffset={6} collisionPadding={8}>
          <Base.Popup ref={popupRef} className="menu" aria-label={label}>
            <div ref={block} className="ind menu-hl" aria-hidden="true" />
            <div className="menu-title" aria-hidden="true">
              {label}
            </div>
            {entries.map((e, i) => (e ? <Item key={i} it={e} /> : null))}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}

/** 列上的「更多」選單 */
export function MenuButton({ label, items }: { label: string; items: (MenuItem | null | false)[] }) {
  return (
    <Menu
      label={label}
      entries={items}
      trigger={
        <button className="btn small icon-only ghost menu-btn" type="button" aria-label={label}>
          <Icon name="more" size={18} />
        </button>
      }
    />
  );
}
