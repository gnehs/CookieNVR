import type { UserDto } from "../../src/api-types.ts";
import type { Role } from "../../src/types.ts";
import { api } from "../api.ts";
import { badge, confirmDialog, errMsg, field, formatAgo, h, icon, openDialog, toast } from "../dom.ts";
import type { PageCtx } from "../router.ts";
import { state } from "../state.ts";
import { settingsLayout } from "./settings-shell.ts";

const ROLE_LABEL: Record<Role, string> = { admin: "管理員", user: "一般使用者" };

function roleSelect(value: Role): HTMLSelectElement {
  const sel = h("select", null, (["user", "admin"] as const).map((r) => h("option", { value: r }, ROLE_LABEL[r])));
  sel.value = value;
  return sel;
}

function passwordDialog(title: string, withUsername: boolean) {
  return openDialog<{ username: string; password: string; role: Role }>(title, (close) => {
    const username = h("input", { type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
    const password = h("input", { type: "password", autocomplete: "new-password", minlength: 8 });
    const role = roleSelect("user");
    const error = h("p", { class: "form-error", role: "alert" });
    const form = h(
      "form",
      { class: "form", novalidate: true },
      withUsername ? field("帳號", username) : null,
      field("密碼", password, "至少 8 個字元"),
      withUsername ? field("角色", role) : null,
      error,
      h(
        "div",
        { class: "dlg-actions" },
        h("button", { class: "btn", type: "button", onclick: () => close() }, "取消"),
        h("button", { class: "btn primary", type: "submit" }, withUsername ? "新增" : "重設密碼"),
      ),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (withUsername && !username.value.trim()) return void (error.textContent = "請填寫帳號");
      if (password.value.length < 8) return void (error.textContent = "密碼至少 8 個字元");
      close({ username: username.value.trim(), password: password.value, role: role.value as Role });
    });
    queueMicrotask(() => (withUsername ? username : password).focus());
    return form;
  });
}

export async function settingsUsersPage(ctx: PageCtx): Promise<Node> {
  const box = h("div");
  const load = async () => {
    const users = await api.users();
    if (!ctx.isCurrent()) return;
    box.replaceChildren(
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          null,
          h("thead", null, h("tr", null, h("th", null, "帳號"), h("th", null, "角色"), h("th", null, "最後登入"), h("th", null))),
          h("tbody", null, users.map((u) => userRow(u, load))),
        ),
      ),
    );
  };
  await load();
  const add = h("button", { class: "btn primary", type: "button" }, icon("plus"), "新增使用者");
  add.addEventListener("click", async () => {
    const r = await passwordDialog("新增使用者", true);
    if (!r) return;
    try {
      await api.createUser(r.username, r.password, r.role);
      toast("已新增使用者");
      await load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  });
  return settingsLayout("users", "使用者", box, add);
}

function userRow(u: UserDto, reload: () => Promise<void>): HTMLElement {
  const self = u.id === state.me?.id;
  const sel = roleSelect(u.role);
  sel.setAttribute("aria-label", `${u.username} 的角色`);
  sel.style.width = "auto";
  sel.addEventListener("change", async () => {
    try {
      await api.updateUser(u.id, { role: sel.value as Role });
      toast("已更新角色");
    } catch (e) {
      toast(errMsg(e), "error");
    }
    await reload();
  });
  return h(
    "tr",
    null,
    h("td", null, h("b", null, u.username), self ? h("span", { class: "muted" }, "（你）") : null),
    h("td", null, self ? badge(ROLE_LABEL[u.role], "muted") : sel),
    h("td", { class: "muted" }, formatAgo(u.lastLoginAt)),
    h(
      "td",
      { class: "actions" },
      h(
        "button",
        {
          class: "btn small",
          type: "button",
          onclick: async () => {
            const r = await passwordDialog(`重設「${u.username}」的密碼`, false);
            if (!r) return;
            try {
              await api.updateUser(u.id, { password: r.password });
              toast("已重設密碼");
            } catch (e) {
              toast(errMsg(e), "error");
            }
          },
        },
        icon("key", 15),
        "重設密碼",
      ),
      h(
        "button",
        {
          class: "btn small danger",
          type: "button",
          disabled: self,
          "aria-label": `刪除 ${u.username}`,
          onclick: async () => {
            if (!(await confirmDialog(`刪除「${u.username}」？`, "這個帳號的登入與 API Token 都會失效，無法復原。", { confirmLabel: "刪除", danger: true }))) return;
            try {
              await api.deleteUser(u.id);
              toast("已刪除");
              await reload();
            } catch (e) {
              toast(errMsg(e), "error");
            }
          },
        },
        icon("trash", 15),
      ),
    ),
  );
}
