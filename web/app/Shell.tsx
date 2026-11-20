import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { camerasQuery } from "../data/queries.ts";
import { infoQuery, logout, useMe } from "../data/session.ts";
import { usePosterPreload } from "../live/posters.ts";
import { useHealth } from "../data/use-health.ts";
import { Icon } from "../ui/Icon.tsx";
import type { IconName } from "../ui/icons.ts";
import { Menu } from "../ui/Menu.tsx";
import { BrandMark } from "../ui/Panel.tsx";
import { useIndicator } from "../ui/indicator.ts";
import { useMedia } from "../ui/useMedia.ts";
import { Tooltip, TooltipGroup } from "../ui/Tooltip.tsx";
import { getSidebarCollapsed, setSidebarCollapsed } from "../theme.ts";

type Section = "cameras" | "events" | "recordings" | "settings" | "account";

const NAV: { section: Section; to: "/cameras" | "/events" | "/recordings"; label: string; icon: IconName }[] = [
  { section: "cameras", to: "/cameras", label: "攝影機", icon: "camera" },
  { section: "events", to: "/events", label: "事件", icon: "activity" },
  { section: "recordings", to: "/recordings", label: "錄影", icon: "film" },
];

const sectionOf = (path: string): Section | undefined => (["cameras", "events", "recordings", "settings", "account"] as const).find((s) => path === `/${s}` || path.startsWith(`/${s}/`));

/** 外殼：桌面是左側欄，手機（≤760px）由 CSS 改成底部導覽列 */
export function Shell() {
  const path = useLocation({ select: (l) => l.pathname });
  // 換頁整頁重新掛載，狀態不會帶到下一頁。key 跟著「已經畫出來的」頁面走：location 在新頁面的程式碼載完前就變了，拿它當 key 會讓舊頁面多掛載一次
  const shown = useRouterState({ select: (s) => s.matches.at(-1)?.pathname });
  const active = sectionOf(path);
  const siteName = useQuery(infoQuery).data?.siteName ?? "CookieNVR";
  const cams = useQuery(camerasQuery).data;
  usePosterPreload(cams?.filter((c) => c.config.enabled).map((c) => c.id) ?? []);
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const toggleLabel = collapsed ? "展開側欄" : "收合側欄";
  const tabBar = useMedia(TAB_BAR);
  const nav = useIndicator<HTMLElement>(tabBar ? `${NAV_CURRENT}, .user-btn[data-current]` : NAV_CURRENT, active);
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="主選單" ref={nav.container}>
        <div className="ind nav-ind" ref={nav.block} aria-hidden="true" />
        <TooltipGroup>
          <div className="brand">
            <BrandMark />
            <span className="brand-name">{siteName}</span>
            <Tooltip
              label={toggleLabel}
              keys={["["]}
              trigger={
                <button className="sidebar-toggle" type="button" aria-label={toggleLabel} aria-keyshortcuts="[" onClick={() => setCollapsed(!collapsed)}>
                  <Icon name="sidebar" size={18} />
                </button>
              }
            />
          </div>
          {NAV.map((n) => (
            <Tooltip
              key={n.section}
              label={n.label}
              disabled={!collapsed}
              trigger={
                <Link className="nav-link" to={n.to} data-section={n.section} aria-current={n.section === active ? "page" : undefined}>
                  <span className="nav-ico">
                    <Icon name={n.icon} size={17} />
                  </span>
                  <span className="nav-label">{n.label}</span>
                </Link>
              }
            />
          ))}
        </TooltipGroup>
        <UserMenu active={active} />
      </nav>
      <main className="main" id="main" tabIndex={-1}>
        <div key={shown} className="page">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

// 手機底部列的「我的」也是一格，在設定或帳號時底色滑到它上面；桌面側欄的使用者卡片在底部、另有自己的樣式
const NAV_CURRENT = '.nav-link[aria-current="page"]';
const TAB_BAR = "(max-width: 760px)";

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** 側欄收合狀態；按 [ 切換（在輸入框裡打字時不算） */
function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(getSidebarCollapsed);
  useEffect(() => setSidebarCollapsed(collapsed), [collapsed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || isTyping(e.target)) return;
      setCollapsed((c) => !c);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return [collapsed, setCollapsed] as const;
}

/** 帳號、設定與登出收在側欄底部（手機是底部列的「我的」）的使用者選單；問題提示點掛在這裡 */
function UserMenu({ active }: { active: Section | undefined }) {
  const me = useMe();
  const isAdmin = me.role === "admin";
  const issues = useHealth(isAdmin)?.issues.length ?? 0;
  const alert = isAdmin && issues > 0;
  const here = active === "settings" || active === "account";
  return (
    <span className="menu-wrap sidebar-foot">
      <Menu
        label={isAdmin ? "帳號與設定" : "帳號"}
        align="start"
        side="top"
        trigger={
          <button
            className="user-btn"
            type="button"
            data-current={here ? "" : undefined}
            aria-label={`${me.username} ${isAdmin ? "管理員" : "一般使用者"}，帳號${isAdmin ? "與設定" : ""}選單${alert ? `，有 ${issues} 件事需要處理` : ""}`}
          >
            <span className="nav-ico">
              <span className="avatar" aria-hidden="true" data-initial={me.username.slice(0, 1)} />
              {alert ? <i className="nav-dot" aria-hidden="true" /> : null}
            </span>
            <span className="who" aria-hidden="true">
              <b>{me.username}</b>
              <small>{isAdmin ? "管理員" : "一般使用者"}</small>
            </span>
            <span className="user-label" aria-hidden="true" />
            <Icon name="selector" size={16} />
          </button>
        }
        entries={[
          { label: "帳號", icon: "user", to: "/account", current: active === "account" },
          isAdmin && {
            label: "設定",
            icon: "settings",
            to: "/settings/cameras",
            current: active === "settings",
            badge: alert ? String(issues) : undefined,
            badgeLabel: alert ? `${issues} 件事需要處理` : undefined,
          },
          { label: "登出", icon: "logout", onSelect: () => void logout() },
        ]}
      />
    </span>
  );
}
