import type { CreatedTokenDto, SessionDto, TokenDto } from "../../src/api-types.ts";
import { api } from "../api.ts";
import { badge, confirmDialog, copyButton, errMsg, errorBox, field, formatAgo, h, icon, nextId, panel, panelSection, spinner, toast } from "../dom.ts";
import { ACCENTS, type ColorMode, getAccent, getMode, setAccent, setMode, systemPrefersDark } from "../theme.ts";
import { navigate, type PageCtx } from "../router.ts";
import { state } from "../state.ts";

function passwordSection(): HTMLElement {
  const cur = h("input", { type: "password", autocomplete: "current-password", required: true });
  const next = h("input", { type: "password", autocomplete: "new-password", required: true, minlength: 8 });
  const again = h("input", { type: "password", autocomplete: "new-password", required: true });
  const error = h("p", { class: "form-error", role: "alert" });
  const submit = h("button", { class: "btn primary", type: "submit" }, "更新密碼");
  const form = panel(
    { tag: "form", title: "變更密碼", foot: [error, submit] },
    panelSection(
      null,
      null,
      h("div", { class: "form narrow" }, field("目前密碼", cur), field("新密碼", next, "至少 8 個字元。變更後，其他裝置需要重新登入。"), field("再次輸入新密碼", again)),
    ),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    if (!cur.value) return void (error.textContent = "請輸入目前密碼");
    if (next.value.length < 8) return void (error.textContent = "新密碼至少要 8 個字元");
    if (next.value !== again.value) return void (error.textContent = "兩次輸入的新密碼不一致");
    submit.disabled = true;
    try {
      await api.changePassword(cur.value, next.value);
      (form as HTMLFormElement).reset();
      toast("已變更密碼");
    } catch (err) {
      error.textContent = errMsg(err);
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

function sessionsSection(): HTMLElement {
  const box = h("div", null, spinner());
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
              h(
                "div",
                { class: "row-main" },
                h("span", { class: "row-ico" }, icon("monitor", 18)),
                h("div", { class: "row-text" }, h("b", null, describeUa(s.userAgent)), h("small", null, s.current ? "就是你現在用的這台" : `上次使用 ${formatAgo(s.lastSeenAt)}`)),
              ),
              s.current
                ? badge("目前裝置", "ok")
                : h(
                    "button",
                    {
                      class: "btn small",
                      type: "button",
                      onclick: async () => {
                        if (!(await confirmDialog(`登出「${describeUa(s.userAgent)}」？`, "這台裝置下次開啟時需要重新登入。", { confirmLabel: "登出", danger: true }))) return;
                        try {
                          await api.revokeSession(s.id);
                          toast("已登出那台裝置");
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
      box.replaceChildren(errorBox(errMsg(e), () => void load()));
    }
  };
  void load();
  return panel({ title: "登入中的裝置" }, box);
}

function describeUa(ua: string): string {
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [os, br].filter(Boolean).join(" 上的 ") || "其他裝置";
}

function tokensSection(): HTMLElement {
  const list = h("div", null, spinner());
  const created = h("div", { "aria-live": "polite" });
  const name = h("input", { type: "text", name: "tokenName", maxlength: 60, placeholder: "例如：Home Assistant", autocomplete: "off" });
  const error = h("p", { class: "form-error", role: "alert" });
  const submit = h("button", { class: "btn primary", type: "submit" }, icon("plus"), "建立 Token");

  const load = async () => {
    try {
      const tokens = await api.tokens();
      list.replaceChildren(
        tokens.length === 0
          ? h("p", { class: "muted", style: "padding:16px 22px" }, "還沒有建立任何 Token。")
          : h(
              "div",
              { class: "row-list" },
              tokens.map((t: TokenDto) =>
                h(
                  "div",
                  { class: "row-item" },
                  h(
                    "div",
                    { class: "row-main" },
                    h("span", { class: "row-ico" }, icon("key", 18)),
                    h("div", { class: "row-text" }, h("b", null, t.name), h("small", null, t.lastUsedAt ? `上次使用 ${formatAgo(t.lastUsedAt)}` : `${formatAgo(t.createdAt)}建立，還沒用過`)),
                  ),
                  h(
                    "button",
                    {
                      class: "btn small danger",
                      type: "button",
                      onclick: async () => {
                        if (!(await confirmDialog(`撤銷「${t.name}」？`, "用這個 Token 連線的程式會立刻無法存取。", { confirmLabel: "撤銷", danger: true }))) return;
                        try {
                          await api.revokeToken(t.id);
                          toast(`已撤銷「${t.name}」`);
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
      list.replaceChildren(errorBox(errMsg(e), () => void load()));
    }
  };

  const form = h("form", { class: "form", novalidate: true }, h("div", { class: "form-actions", style: "align-items:end" }, h("div", { style: "flex:1;min-width:200px" }, field("用途", name)), submit), error);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    if (!name.value.trim()) {
      name.focus();
      return void (error.textContent = "請寫下這個 Token 要給什麼用");
    }
    submit.disabled = true;
    try {
      const t: CreatedTokenDto = await api.createToken(name.value.trim());
      name.value = "";
      created.replaceChildren(
        h(
          "div",
          { class: "callout warn" },
          icon("key"),
          h(
            "div",
            { style: "flex:1;min-width:0" },
            h("b", null, `「${t.name}」的 Token 只會顯示這一次`),
            h("p", null, "現在複製起來，貼到那個程式的設定裡。離開這頁後就看不到完整內容了。"),
            h(
              "div",
              { class: "secret-box", style: "margin-top:8px" },
              h("code", { translate: "no" }, t.token),
              copyButton("複製", () => t.token, { class: "small", done: "已複製 Token" }),
              h("button", { class: "btn small", type: "button", onclick: () => created.replaceChildren() }, "我已經存好了"),
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
  const listSection = h("div", { class: "panel-section", style: "padding:0" }, list);
  return panel(
    { title: "API Token" },
    panelSection(null, "讓 Home Assistant 等其他程式不用你的密碼也能存取，權限和你的帳號相同。不用時可以隨時撤銷。", created, form),
    listSection,
  );
}

function modeThumb(mode: ColorMode): HTMLElement {
  const pane = (dark: boolean) => h("span", { class: `thumb-inner${dark ? " dark" : ""}` }, h("i"), h("i"));
  return h("span", { class: "thumb", "aria-hidden": "true" }, mode === "system" ? h("span", { class: "thumb-split" }, pane(false), pane(true)) : pane(mode === "dark"));
}

function appearanceSection(ctx: PageCtx): HTMLElement {
  const modeName = nextId("mode");
  const systemNow = h("small");
  const syncSystem = () => (systemNow.textContent = `目前為${systemPrefersDark.matches ? "深色" : "淺色"}`);
  syncSystem();
  systemPrefersDark.addEventListener("change", syncSystem);
  ctx.onCleanup(() => systemPrefersDark.removeEventListener("change", syncSystem));
  const current = getMode();
  const modes: [ColorMode, string][] = [
    ["light", "淺色"],
    ["dark", "深色"],
    ["system", "跟隨系統"],
  ];
  const modeGroup = h(
    "div",
    { class: "tiles modes", role: "radiogroup", "aria-label": "色彩模式" },
    modes.map(([value, label]) => {
      const input = h("input", { type: "radio", name: modeName, value, checked: value === current, "aria-label": label });
      input.addEventListener("change", () => input.checked && setMode(value));
      return h("label", { class: "tile" }, input, modeThumb(value), h("span", { class: "tile-label" }, label, value === "system" ? systemNow : null));
    }),
  );

  const accentName = nextId("accent");
  const accent = getAccent();
  const swatches = h(
    "div",
    { class: "swatches", role: "radiogroup", "aria-label": "主色" },
    ACCENTS.map((a) => {
      const input = h("input", { type: "radio", name: accentName, value: a.id, checked: a.id === accent, "aria-label": a.label });
      input.addEventListener("change", () => input.checked && setAccent(a.id));
      return h(
        "label",
        { class: "swatch", "data-accent": a.id },
        input,
        h("span", { class: "swatch-face" }, h("span", { class: "swatch-dot", "aria-hidden": "true" }, icon("check", 15)), a.label),
      );
    }),
  );

  return panel(
    { title: "外觀", actions: h("span", { class: "hint" }, "只套用在這個瀏覽器") },
    panelSection("色彩模式", "選擇淺色或深色，或跟著系統自動切換。", modeGroup),
    panelSection("主色", "用在按鈕、選取狀態與導覽列。", swatches),
  );
}

export function accountPage(ctx: PageCtx): Node {
  const logout = h("button", { class: "btn", type: "button" }, icon("logout"), "登出");
  logout.addEventListener("click", async () => {
    await api.logout().catch(() => {});
    state.me = null;
    navigate("/login");
    location.reload();
  });
  const me = state.me;
  return h(
    "div",
    { class: "form-page" },
    h(
      "header",
      { class: "page-head" },
      h(
        "div",
        { class: "row-main", style: "flex:none" },
        h("span", { class: "avatar", style: "width:48px;height:48px;font-size:20px", "aria-hidden": "true" }, me?.username.slice(0, 1) ?? ""),
        h("div", null, h("h1", null, me?.username ?? "帳號"), h("p", null, me?.role === "admin" ? "管理員" : "一般使用者")),
      ),
      h("div", { class: "page-actions" }, logout),
    ),
    h("div", { class: "stack" }, appearanceSection(ctx), passwordSection(), sessionsSection(), tokensSection()),
  );
}
