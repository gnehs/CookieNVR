import { api, setUnauthorizedHandler } from "./api.ts";
import { attachMenu, errMsg, errorBox, h, icon, PageError, pageErrorBox, spinner } from "./dom.ts";
import { matchRoute, navigate, parseHash, type PageCtx, type Route } from "./router.ts";
import { state } from "./state.ts";
import { onHealth, startHealthWatch, stopHealthWatch } from "./health-watch.ts";
import { startStatusStream, stopStatusStream } from "./status-stream.ts";
import "./theme.ts";
import { loginPage, setupPage } from "./pages/auth.ts";
import { camerasPage } from "./pages/cameras.ts";
import { cameraPage } from "./pages/camera.ts";
import { recordingsPage } from "./pages/recordings.ts";
import { cameraFormPage, settingsCamerasPage } from "./pages/settings-cameras.ts";
import { settingsStoragePage } from "./pages/settings-storage.ts";
import { settingsSystemPage } from "./pages/settings-system.ts";
import { settingsUsersPage } from "./pages/settings-users.ts";
import { settingsStatusPage } from "./pages/settings-status.ts";
import { SETTINGS_TABS } from "./pages/settings-shell.ts";
import { accountPage } from "./pages/account.ts";

const routes: Route[] = [
  { pattern: "/setup", page: setupPage, access: "public" },
  { pattern: "/login", page: loginPage, access: "public" },
  { pattern: "/cameras", page: camerasPage, access: "user", section: "cameras" },
  { pattern: "/cameras/:id", page: (c) => cameraPage(c, c.params.id!), access: "user", section: "cameras" },
  { pattern: "/recordings", page: recordingsPage, access: "user", section: "recordings" },
  { pattern: "/settings/cameras", page: settingsCamerasPage, access: "admin", section: "settings" },
  { pattern: "/welcome", page: (c) => cameraFormPage(c, null, "welcome"), access: "admin", bare: true },
  { pattern: "/settings/cameras/new", page: (c) => cameraFormPage(c, null), access: "admin", section: "settings" },
  { pattern: "/settings/cameras/:id", page: (c) => cameraFormPage(c, c.params.id!), access: "admin", section: "settings" },
  { pattern: "/settings/storage", page: settingsStoragePage, access: "admin", section: "settings" },
  { pattern: "/settings/system", page: settingsSystemPage, access: "admin", section: "settings" },
  { pattern: "/settings/users", page: settingsUsersPage, access: "admin", section: "settings" },
  { pattern: "/settings/status", page: settingsStatusPage, access: "admin", section: "settings" },
  { pattern: "/account", page: accountPage, access: "user", section: "account" },
];

const app = document.getElementById("app")!;
let cleanups: (() => void)[] = [];
let renderToken = 0;
let currentSection: string | undefined;
let shell: { root: HTMLElement; main: HTMLElement; nav: HTMLElement } | null = null;

function runCleanups() {
  for (const fn of cleanups) {
    try {
      fn();
    } catch {}
  }
  cleanups = [];
}

function makeCtx(params: Record<string, string>, query: URLSearchParams, token: number): PageCtx {
  return {
    params,
    query,
    onCleanup: (fn) => cleanups.push(fn),
    every(ms, fn) {
      const id = setInterval(() => {
        if (!document.hidden && token === renderToken) fn();
      }, ms);
      cleanups.push(() => clearInterval(id));
    },
    isCurrent: () => token === renderToken,
  };
}

const NAV = [
  { section: "cameras", href: "#/cameras", label: "攝影機", icon: "camera" },
  { section: "recordings", href: "#/recordings", label: "錄影", icon: "film" },
] as const;

let issueCount = 0;
onHealth(({ health }) => {
  if (health.issues.length === issueCount) return;
  // 選單開著時不重畫，免得把它關掉；下一次輪詢再更新
  if (shell?.nav.querySelector(".menu:popover-open")) return;
  issueCount = health.issues.length;
  renderNav(currentSection);
});

function buildShell() {
  const nav = h("nav", { class: "sidebar", "aria-label": "主選單" });
  const main = h("main", { class: "main", id: "main", tabindex: "-1" });
  const root = h("div", { class: "shell" }, nav, main);
  shell = { root, main, nav };
  renderNav();
  return shell;
}

async function logout() {
  await api.logout().catch(() => {});
  state.me = null;
  navigate("/login");
  location.reload();
}

/** 帳號、設定與登出收在側欄底部（手機是底部列的「我的」）的使用者選單；問題提示點掛在這裡 */
function userMenu(active: string | undefined): HTMLElement | null {
  const me = state.me;
  if (!me) return null;
  const isAdmin = me.role === "admin";
  const alert = isAdmin && issueCount > 0;
  const here = active === "settings" || active === "account";
  const { path } = parseHash();
  const btn = h(
    "button",
    { class: "user-btn", type: "button", "data-current": here ? "" : null, "aria-label": `${me.username}，${isAdmin ? "管理員" : "一般使用者"}，帳號${isAdmin ? "與設定" : ""}選單${alert ? `，有 ${issueCount} 件事需要處理` : ""}` },
    h("span", { class: "nav-ico" }, h("span", { class: "avatar", "aria-hidden": "true" }, me.username.slice(0, 1)), alert ? h("i", { class: "nav-dot", "aria-hidden": "true" }) : null),
    h("span", { class: "who", "aria-hidden": "true" }, h("b", null, me.username), h("small", null, isAdmin ? "管理員" : "一般使用者")),
    h("span", { class: "user-label", "aria-hidden": "true" }, "我的"),
    icon("selector", 16),
  );
  const { wrap } = attachMenu(
    btn,
    isAdmin ? "帳號與設定" : "帳號",
    [
      { label: "帳號", icon: "user", href: "#/account", current: active === "account" },
      isAdmin
        ? {
            heading: "設定",
            items: SETTINGS_TABS.map(([key, label]) => ({
              label,
              href: `#/settings/${key}`,
              current: path === `/settings/${key}`,
              badge: key === "status" && alert ? String(issueCount) : undefined,
              badgeLabel: key === "status" && alert ? `${issueCount} 件事需要處理` : undefined,
            })),
          }
        : null,
      { label: "登出", icon: "logout", onSelect: () => void logout() },
    ],
    { align: "start", side: "top" },
  );
  wrap.classList.add("sidebar-foot");
  return wrap;
}

function renderNav(active?: string) {
  if (!shell) return;
  shell.nav.replaceChildren(
    h("div", { class: "brand" }, h("span", { class: "brand-mark" }, icon("camera", 17)), h("span", null, state.siteName)),
    ...NAV.map((n) => h("a", { class: "nav-link", href: n.href, "aria-current": n.section === active ? "page" : null }, h("span", { class: "nav-ico" }, icon(n.icon, 20)), n.label)),
    ...[userMenu(active)].filter((n): n is HTMLElement => n !== null),
  );
}

async function render() {
  const token = ++renderToken;
  runCleanups();
  const { path, query } = parseHash();
  if (path === "/") return navigate(state.me ? "/cameras" : "/login", true);

  if (state.info?.needsSetup && path !== "/setup") return navigate("/setup", true);

  const match = matchRoute(routes, path);
  if (!match) return navigate(state.me ? "/cameras" : "/login", true);
  const { route, params } = match;

  if (route.access === "public") {
    if (path === "/setup" && state.info && !state.info.needsSetup) return navigate("/login", true);
    if (path === "/login" && state.me) return navigate("/cameras", true);
    shell = null;
    document.title = state.siteName;
    app.replaceChildren(enter(await runPage(route, params, query, token)));
    return;
  }

  if (!state.me) {
    try {
      state.me = await api.me();
    } catch {
      return navigate("/login", true);
    }
    if (token !== renderToken) return;
  }
  if (route.access === "admin" && state.me.role !== "admin") return navigate("/cameras", true);
  startStatusStream();
  if (state.me.role === "admin") startHealthWatch();

  if (route.bare) {
    shell = null;
    document.title = state.siteName;
    app.replaceChildren(spinner());
    const content = await runPage(route, params, query, token);
    if (token !== renderToken) return;
    app.replaceChildren(enter(content));
    window.scrollTo(0, 0);
    return;
  }

  const s = shell ?? buildShell();
  if (!app.contains(s.root)) app.replaceChildren(s.root);
  currentSection = route.section;
  renderNav(currentSection);
  s.main.replaceChildren(spinner());
  const content = await runPage(route, params, query, token);
  if (token !== renderToken) return;
  s.main.replaceChildren(enter(content));
  window.scrollTo(0, 0);
}

/** 換頁時新內容淡入；只加在最外層，頁面內部的輪詢更新不會重播 */
function enter(node: Node): Node {
  if (node instanceof HTMLElement) node.classList.add("page-enter");
  return node;
}

async function runPage(route: Route, params: Record<string, string>, query: URLSearchParams, token: number): Promise<Node> {
  try {
    return await route.page(makeCtx(params, query, token));
  } catch (e) {
    return e instanceof PageError ? pageErrorBox(e) : errorBox(errMsg(e), () => void render());
  }
}

let handling401 = false;
setUnauthorizedHandler(() => {
  if (handling401 || !state.me) return;
  handling401 = true;
  state.me = null;
  shell = null;
  stopHealthWatch();
  stopStatusStream();
  issueCount = 0;
  navigate("/login");
  setTimeout(() => (handling401 = false), 500);
});

window.addEventListener("hashchange", () => void render());
window.addEventListener("sitenamechange", () => renderNav(currentSection));

async function boot() {
  app.replaceChildren(spinner());
  try {
    state.info = await api.info();
    state.siteName = state.info.siteName;
  } catch (e) {
    app.replaceChildren(h("div", { class: "auth" }, errorBox(errMsg(e), () => void boot())));
    return;
  }
  if (!state.info.needsSetup) {
    try {
      state.me = await api.me();
    } catch {}
  }
  await render();
}

void boot();
