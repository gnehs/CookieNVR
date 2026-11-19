import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useRouterState } from "@tanstack/react-router";
import { infoQuery, logout, useMe } from "../data/session.ts";
import { useHealth } from "../data/use-health.ts";
import { SETTINGS_TABS } from "../pages/settings/SettingsLayout.tsx";
import { Icon } from "../ui/Icon.tsx";
import type { IconName } from "../ui/icons.ts";
import { Menu } from "../ui/Menu.tsx";
import { BrandMark } from "../ui/Panel.tsx";

type Section = "cameras" | "events" | "recordings" | "settings" | "account";

const NAV: { section: Section; to: "/cameras" | "/events" | "/recordings"; label: string; icon: IconName }[] = [
  { section: "cameras", to: "/cameras", label: "攝影機", icon: "camera" },
  { section: "events", to: "/events", label: "事件", icon: "activity" },
  { section: "recordings", to: "/recordings", label: "錄影", icon: "film" },
];

const sectionOf = (path: string): Section | undefined => (["cameras", "events", "recordings", "settings", "account"] as const).find((s) => path === `/${s}` || path.startsWith(`/${s}/`));

/** 外殼：桌面是左側欄，手機（≤760px）由 CSS 改成底部導覽列；頁面內容換頁時淡入 */
export function Shell() {
  const path = useLocation({ select: (l) => l.pathname });
  // 淡入的 key 跟著「已經畫出來的」頁面走：location 在新頁面的程式碼載完前就變了，拿它當 key 會讓舊頁面多掛載一次
  const shown = useRouterState({ select: (s) => s.matches.at(-1)?.pathname });
  const active = sectionOf(path);
  const siteName = useQuery(infoQuery).data?.siteName ?? "CookieNVR";
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="主選單">
        <div className="brand">
          <BrandMark />
          <span>{siteName}</span>
        </div>
        {NAV.map((n) => (
          <Link key={n.section} className="nav-link" to={n.to} aria-current={n.section === active ? "page" : undefined}>
            <span className="nav-ico">
              <Icon name={n.icon} size={20} />
            </span>
            {n.label}
          </Link>
        ))}
        <UserMenu active={active} path={path} />
      </nav>
      <main className="main" id="main" tabIndex={-1}>
        <div key={shown} className="page-enter">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

/** 帳號、設定與登出收在側欄底部（手機是底部列的「我的」）的使用者選單；問題提示點掛在這裡 */
function UserMenu({ active, path }: { active: Section | undefined; path: string }) {
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
            heading: "設定",
            items: SETTINGS_TABS.map(([key, label]) => ({
              label,
              to: `/settings/${key}` as const,
              current: path === `/settings/${key}`,
              badge: key === "status" && alert ? String(issues) : undefined,
              badgeLabel: key === "status" && alert ? `${issues} 件事需要處理` : undefined,
            })),
          },
          { label: "登出", icon: "logout", onSelect: () => void logout() },
        ]}
      />
    </span>
  );
}
