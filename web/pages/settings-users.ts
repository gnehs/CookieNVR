import type { UserDto } from "../../src/api-types.ts";
import type { Role } from "../../src/types.ts";
import { api } from "../api.ts";
import { badge, confirmDialog, errMsg, field, formatAgo, h, icon, menuButton, openDialog, panel, segmented, tiles, toast } from "../dom.ts";
import type { PageCtx } from "../router.ts";
import { state } from "../state.ts";
import { settingsLayout } from "./settings-shell.ts";

const ROLE_LABEL: Record<Role, string> = { admin: "管理員", user: "一般使用者" };

function passwordDialog(title: string, withUsername: boolean) {
  return openDialog<{ username: string; password: string; role: Role }>(title, (close) => {
    const username = h("input", { type: "text", name: "username", autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
    const password = h("input", { type: "password", name: "password", autocomplete: "new-password", minlength: 8 });
    let role: Role = "user";
    const roleTiles = tiles(
      "角色",
      [
        { value: "user", label: ROLE_LABEL.user, desc: "可以看畫面與錄影" },
        { value: "admin", label: ROLE_LABEL.admin, desc: "還可以變更所有設定" },
      ],
      role,
      (v) => (role = v),
    );
    const error = h("p", { class: "form-error", role: "alert" });
    const form = h(
      "form",
      { class: "form", novalidate: true },
      withUsername ? field("帳號", username) : null,
      field("密碼", password, "至少 8 個字元"),
      withUsername ? h("div", { class: "field" }, h("span", { class: "legend" }, "角色"), roleTiles) : null,
      error,
      h(
        "div",
        { class: "dlg-actions" },
        h("button", { class: "btn", type: "button", onclick: () => close() }, "取消"),
        h("button", { class: "btn primary", type: "submit" }, withUsername ? "新增使用者" : "重設密碼"),
      ),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (withUsername && !username.value.trim()) {
        username.focus();
        return void (error.textContent = "請填寫帳號");
      }
      if (password.value.length < 8) {
        password.focus();
        return void (error.textContent = "密碼至少要 8 個字元");
      }
      close({ username: username.value.trim(), password: password.value, role });
    });
    queueMicrotask(() => (withUsername ? username : password).focus());
    return form;
  });
}

export async function settingsUsersPage(ctx: PageCtx): Promise<Node> {
  const box = h("div");
  const count = h("span", { class: "hint" });
  const load = async () => {
    const users = await api.users();
    if (!ctx.isCurrent()) return;
    count.textContent = `共 ${users.length} 位`;
    box.replaceChildren(h("div", { class: "row-list", role: "list" }, users.map((u) => userRow(u, load))));
  };
  await load();
  const add = h("button", { class: "btn primary small", type: "button" }, icon("plus", 15), "新增使用者");
  add.addEventListener("click", async () => {
    const r = await passwordDialog("新增使用者", true);
    if (!r) return;
    try {
      await api.createUser(r.username, r.password, r.role);
      toast(`已新增「${r.username}」`);
      await load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  });
  return settingsLayout("users", panel({ actions: [count, add] }, box));
}

async function resetPassword(u: UserDto) {
  const r = await passwordDialog(`重設「${u.username}」的密碼`, false);
  if (!r) return;
  try {
    await api.updateUser(u.id, { password: r.password });
    toast(`已重設「${u.username}」的密碼`);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

async function remove(u: UserDto, reload: () => Promise<void>) {
  if (!(await confirmDialog(`刪除「${u.username}」？`, "這個帳號會立刻無法登入，它建立的 API Token 也會失效。無法復原。", { confirmLabel: "刪除", danger: true }))) return;
  try {
    await api.deleteUser(u.id);
    toast(`已刪除「${u.username}」`);
    await reload();
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

function userRow(u: UserDto, reload: () => Promise<void>): HTMLElement {
  const self = u.id === state.me?.id;
  const roleCtl = segmented(
    `${u.username} 的角色`,
    [
      { value: "user", label: "一般使用者" },
      { value: "admin", label: "管理員" },
    ],
    u.role,
    async (role: Role) => {
      try {
        await api.updateUser(u.id, { role });
        toast(`「${u.username}」現在是${ROLE_LABEL[role]}`);
      } catch (e) {
        toast(errMsg(e), "error");
      }
      await reload();
    },
  );
  return h(
    "div",
    { class: "row-item", role: "listitem" },
    h(
      "div",
      { class: "row-main" },
      h("span", { class: "avatar", "aria-hidden": "true" }, u.username.slice(0, 1)),
      h(
        "div",
        { class: "row-text" },
        h("b", { class: "user-name" }, h("span", { class: "truncate" }, u.username), self ? h("span", { class: "badge accent plain" }, "你") : null),
        h("small", null, u.lastLoginAt ? `上次登入 ${formatAgo(u.lastLoginAt)}` : "還沒登入過"),
      ),
    ),
    self ? badge(ROLE_LABEL[u.role], "muted") : roleCtl,
    h(
      "div",
      { class: "row-actions" },
      menuButton(`「${u.username}」的更多動作`, [
        { label: "重設密碼", icon: "key", onSelect: () => void resetPassword(u) },
        self ? null : { label: "刪除", icon: "trash", danger: true, onSelect: () => void remove(u, reload) },
      ]),
    ),
  );
}
