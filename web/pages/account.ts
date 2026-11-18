import type { CreatedTokenDto, SessionDto, TokenDto } from "../../src/api-types.ts";
import { api } from "../api.ts";
import { badge, confirmDialog, copyWithToast, errMsg, field, formatAgo, h, icon, pageHeader, toast } from "../dom.ts";
import { navigate, type PageCtx } from "../router.ts";
import { state } from "../state.ts";

function passwordSection(): HTMLElement {
  const cur = h("input", { type: "password", autocomplete: "current-password", required: true });
  const next = h("input", { type: "password", autocomplete: "new-password", required: true, minlength: 8 });
  const again = h("input", { type: "password", autocomplete: "new-password", required: true });
  const error = h("p", { class: "form-error", role: "alert" });
  const submit = h("button", { class: "btn primary", type: "submit" }, "更新密碼");
  const form = h(
    "form",
    { class: "form", novalidate: true },
    field("目前密碼", cur),
    field("新密碼", next, "至少 8 個字元。更新後，其他裝置會被登出。"),
    field("再次輸入新密碼", again),
    error,
    h("div", null, submit),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    if (!cur.value) return void (error.textContent = "請輸入目前密碼");
    if (next.value.length < 8) return void (error.textContent = "新密碼至少 8 個字元");
    if (next.value !== again.value) return void (error.textContent = "兩次輸入的新密碼不一致");
    submit.disabled = true;
    try {
      await api.changePassword(cur.value, next.value);
      form.reset();
      toast("已更新密碼");
    } catch (err) {
      error.textContent = errMsg(err);
    } finally {
      submit.disabled = false;
    }
  });
  return h("section", { class: "section" }, h("h2", null, "改密碼"), h("div", { class: "card" }, form));
}

function sessionsSection(): HTMLElement {
  const box = h("div", { class: "card flush" });
  const load = async () => {
    try {
      const list = await api.sessions();
      box.replaceChildren(
        h(
          "div",
          { class: "row-list" },
          list.map((s: SessionDto) =>
            h(
              "div",
              { class: "row-item" },
              h("div", { class: "row-main" }, h("b", null, describeUa(s.userAgent)), h("small", null, `${s.ip} · 最近使用 ${formatAgo(s.lastSeenAt)}`)),
              s.current
                ? badge("目前裝置", "ok")
                : h(
                    "button",
                    {
                      class: "btn small",
                      type: "button",
                      onclick: async () => {
                        if (!(await confirmDialog("登出這台裝置？", describeUa(s.userAgent), { confirmLabel: "登出", danger: true }))) return;
                        try {
                          await api.revokeSession(s.id);
                          toast("已登出");
                          await load();
                        } catch (e) {
                          toast(errMsg(e), "error");
                        }
                      },
                    },
                    icon("logout", 15),
                    "登出",
                  ),
            ),
          ),
        ),
      );
    } catch (e) {
      box.replaceChildren(h("p", { class: "form-error", style: "padding:14px" }, errMsg(e)));
    }
  };
  void load();
  return h("section", { class: "section" }, h("h2", null, "登入裝置"), box);
}

function describeUa(ua: string): string {
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [br, os].filter(Boolean).join("，") || ua.slice(0, 60) || "未知裝置";
}

function tokensSection(): HTMLElement {
  const list = h("div", { class: "card flush" });
  const created = h("div", { "aria-live": "polite" });
  const name = h("input", { type: "text", maxlength: 60, placeholder: "例如：Home Assistant", autocomplete: "off" });
  const error = h("p", { class: "form-error", role: "alert" });
  const submit = h("button", { class: "btn primary", type: "submit" }, icon("plus"), "建立");

  const load = async () => {
    try {
      const tokens = await api.tokens();
      list.replaceChildren(
        tokens.length === 0
          ? h("p", { class: "muted", style: "padding:14px" }, "還沒有 API Token。")
          : h(
              "div",
              { class: "row-list" },
              tokens.map((t: TokenDto) =>
                h(
                  "div",
                  { class: "row-item" },
                  h("div", { class: "row-main" }, h("b", null, t.name), h("small", null, `${t.prefix}…  ·  建立於 ${formatAgo(t.createdAt)}  ·  最後使用 ${formatAgo(t.lastUsedAt)}`)),
                  h(
                    "button",
                    {
                      class: "btn small danger",
                      type: "button",
                      onclick: async () => {
                        if (!(await confirmDialog(`撤銷「${t.name}」？`, "使用這個 Token 的裝置或整合會立刻失去存取權。", { confirmLabel: "撤銷", danger: true }))) return;
                        try {
                          await api.revokeToken(t.id);
                          toast("已撤銷");
                          await load();
                        } catch (e) {
                          toast(errMsg(e), "error");
                        }
                      },
                    },
                    icon("trash", 15),
                    "撤銷",
                  ),
                ),
              ),
            ),
      );
    } catch (e) {
      list.replaceChildren(h("p", { class: "form-error", style: "padding:14px" }, errMsg(e)));
    }
  };

  const form = h("form", { class: "form", style: "max-width:none", novalidate: true }, h("div", { class: "form-actions" }, h("div", { style: "flex:1;min-width:200px" }, field("新增 Token 名稱", name)), h("div", { style: "align-self:end" }, submit)), error);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    if (!name.value.trim()) return void (error.textContent = "請填寫名稱");
    submit.disabled = true;
    try {
      const t: CreatedTokenDto = await api.createToken(name.value.trim());
      name.value = "";
      created.replaceChildren(
        h(
          "div",
          { class: "callout warn", style: "margin-bottom:12px" },
          icon("key"),
          h(
            "div",
            { style: "flex:1;min-width:0" },
            h("b", null, `「${t.name}」的 Token 只會顯示這一次`),
            h("p", { class: "muted" }, "請現在複製並保存，關閉後就無法再看到完整內容。"),
            h(
              "div",
              { class: "secret-box", style: "margin-top:8px" },
              h("code", null, t.token),
              h("button", { class: "btn small", type: "button", onclick: () => copyWithToast(t.token, " Token") }, icon("copy", 15), "複製"),
              h("button", { class: "btn small", type: "button", onclick: () => created.replaceChildren() }, "我已保存"),
            ),
          ),
        ),
      );
      await load();
    } catch (err) {
      error.textContent = errMsg(err);
    } finally {
      submit.disabled = false;
    }
  });
  void load();
  return h("section", { class: "section" }, h("h2", null, "API Token"), h("p", { class: "hint", style: "margin-bottom:10px" }, "給 Home Assistant、電視牆或腳本使用。Token 繼承你的角色，用法是 Authorization: Bearer <token>。"), created, h("div", { class: "card", style: "margin-bottom:10px" }, form), list);
}

export function accountPage(_ctx: PageCtx): Node {
  const logout = h("button", { class: "btn", type: "button" }, icon("logout"), "登出");
  logout.addEventListener("click", async () => {
    await api.logout().catch(() => {});
    state.me = null;
    navigate("/login");
    location.reload();
  });
  return h(
    "div",
    null,
    pageHeader("帳號", logout),
    h("p", { class: "muted" }, `${state.me?.username}（${state.me?.role === "admin" ? "管理員" : "一般使用者"}）`),
    passwordSection(),
    sessionsSection(),
    tokensSection(),
  );
}
