import { api } from "../api.ts";
import { errMsg, field, h, icon } from "../dom.ts";
import { navigate, type PageCtx } from "../router.ts";
import { state } from "../state.ts";

function authForm(opts: {
  title: string;
  submitLabel: string;
  confirm: boolean;
  onSubmit: (username: string, password: string) => Promise<void>;
  intro?: string;
}): HTMLElement {
  const username = h("input", { type: "text", autocomplete: "username", required: true, autocapitalize: "off", spellcheck: "false" });
  const password = h("input", {
    type: "password",
    autocomplete: opts.confirm ? "new-password" : "current-password",
    required: true,
    minlength: opts.confirm ? 8 : null,
  });
  const confirm = h("input", { type: "password", autocomplete: "new-password", required: opts.confirm });
  const error = h("p", { class: "form-error", role: "alert" });
  const submit = h("button", { class: "btn primary", type: "submit" }, opts.submitLabel);

  const form = h(
    "form",
    { class: "form", novalidate: true },
    field("帳號", username),
    field("密碼", password, opts.confirm ? "至少 8 個字元" : undefined),
    opts.confirm ? field("再次輸入密碼", confirm) : null,
    error,
    submit,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    const u = username.value.trim();
    if (!u || !password.value) {
      error.textContent = "請輸入帳號與密碼";
      return;
    }
    if (opts.confirm) {
      if (password.value.length < 8) {
        error.textContent = "密碼至少 8 個字元";
        password.focus();
        return;
      }
      if (password.value !== confirm.value) {
        error.textContent = "兩次輸入的密碼不一致";
        confirm.focus();
        return;
      }
    }
    submit.disabled = true;
    try {
      await opts.onSubmit(u, password.value);
    } catch (err) {
      error.textContent = errMsg(err);
      submit.disabled = false;
    }
  });
  queueMicrotask(() => username.focus());

  return h(
    "div",
    { class: "auth" },
    h(
      "div",
      { class: "card auth-card" },
      h("div", { class: "brand" }, h("span", { class: "brand-mark" }, icon("camera", 16)), state.siteName),
      h("h1", null, opts.title),
      opts.intro && h("p", { class: "muted" }, opts.intro),
      form,
    ),
  );
}

export function loginPage(_ctx: PageCtx): Node {
  return authForm({
    title: "登入",
    submitLabel: "登入",
    confirm: false,
    onSubmit: async (u, p) => {
      state.me = await api.login(u, p);
      if (state.me.role === "admin") {
        const s = await api.settings().catch(() => null);
        if (s) state.siteName = s.siteName;
      }
      navigate("/cameras");
    },
  });
}

export function setupPage(_ctx: PageCtx): Node {
  return authForm({
    title: "初始設定",
    intro: "第一次使用，請建立管理員帳號。",
    submitLabel: "建立並登入",
    confirm: true,
    onSubmit: async (u, p) => {
      state.me = await api.setup(u, p);
      state.info = await api.info();
      navigate("/cameras");
    },
  });
}
