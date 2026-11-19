import type { PtzPresetDto } from "../../src/api-types.ts";
import { api } from "../api.ts";
import { confirmDialog, errMsg, field, h, icon, openDialog, toast } from "../dom.ts";

export interface PresetsOptions {
  cameraId: string;
  presets: PtzPresetDto[];
  /** 相機回報的上限；沒回報就是 null */
  max: number | null;
  admin: boolean;
  speed: () => number;
  /** 前往預置點前先停掉方向控制 */
  beforeGo: () => void;
  /** 在面板的狀態列顯示一句話 */
  say: (text: string | null, tone?: "info" | "error") => void;
}

/**
 * 預置點清單：點名稱就前往。管理員另有「儲存目前位置」與編輯模式（覆寫、刪除）。
 * 一般使用者沒有任何預置點時整段不出現。
 */
export function presetSection(opts: PresetsOptions): HTMLElement {
  let presets = opts.presets;
  let editing = false;
  let goingTo: string | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  const list = h("ul", { class: "ptz-presets" });
  const editBtn = h("button", { class: "btn small ghost", type: "button", "aria-pressed": "false" }, "編輯");
  const addBtn = h("button", { class: "btn small", type: "button" }, icon("plus", 16), "儲存目前位置");
  const limit = h("p", { class: "ptz-hint", id: "ptz-limit" });
  const empty = h("p", { class: "ptz-hint" }, "還沒有預置點。把鏡頭轉到想要的位置，再按「儲存目前位置」。");
  const head = h("div", { class: "ptz-sub" }, h("h3", null, "預置點"), h("div", { class: "ptz-sub-tools" }, addBtn, editBtn));
  const el = h("div", { class: "ptz-section" }, head, limit, list, empty);

  const full = () => opts.max !== null && presets.length >= opts.max;

  async function go(p: PtzPresetDto) {
    opts.beforeGo();
    goingTo = p.token;
    clearTimeout(flashTimer);
    opts.say(`前往「${p.name}」`);
    render();
    try {
      await api.ptzGotoPreset(opts.cameraId, p.token, opts.speed());
      flashTimer = setTimeout(() => opts.say(null), 1800);
    } catch (e) {
      opts.say(errMsg(e), "error");
    } finally {
      goingTo = null;
      render();
    }
  }

  async function overwrite(p: PtzPresetDto) {
    const ok = await confirmDialog("覆寫預置點", `要把「${p.name}」改成鏡頭現在的位置嗎？原本的位置會被取代。`, { confirmLabel: "覆寫" });
    if (!ok) return;
    try {
      const res = await api.ptzSavePreset(opts.cameraId, { name: p.name, token: p.token });
      presets = res.presets;
      toast(`已把「${p.name}」更新為目前位置`);
    } catch (e) {
      toast(errMsg(e), "error");
    }
    render();
  }

  async function remove(p: PtzPresetDto) {
    const ok = await confirmDialog("刪除預置點", `要刪除「${p.name}」嗎？這個預置點會從相機上移除。`, { confirmLabel: "刪除", danger: true });
    if (!ok) return;
    try {
      presets = (await api.ptzRemovePreset(opts.cameraId, { token: p.token })).presets;
      if (presets.length === 0) editing = false;
      toast(`已刪除「${p.name}」`);
    } catch (e) {
      toast(errMsg(e), "error");
    }
    render();
  }

  async function add() {
    const name = await openDialog<string>("儲存目前位置", (close) => {
      const input = h("input", { type: "text", maxlength: 30, autocomplete: "off", placeholder: "例如：大門", required: true, autofocus: true });
      const error = h("p", { class: "form-error", role: "alert" });
      const submit = h("button", { class: "btn primary", type: "submit" }, "儲存");
      const form = h(
        "form",
        { class: "form" },
        field("預置點名稱", input, "鏡頭現在對著的位置會存到相機裡。"),
        error,
        h("div", { class: "dlg-actions" }, h("button", { class: "btn", type: "button", onclick: () => close() }, "取消"), submit),
      );
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const value = input.value.trim();
        if (!value) {
          error.textContent = "請幫這個位置取個名稱";
          input.focus();
          return;
        }
        error.textContent = "";
        submit.disabled = true;
        submit.setAttribute("aria-busy", "true");
        try {
          presets = (await api.ptzSavePreset(opts.cameraId, { name: value })).presets;
          close(value);
        } catch (err) {
          error.textContent = errMsg(err);
          submit.disabled = false;
          submit.removeAttribute("aria-busy");
        }
      });
      return form;
    });
    if (name) toast(`已儲存「${name}」`);
    render();
  }

  function row(p: PtzPresetDto) {
    const goBtn = h("button", { class: "ptz-preset-go", type: "button", "aria-busy": goingTo === p.token ? "true" : null, onclick: () => go(p) }, h("span", null, p.name));
    return h(
      "li",
      { class: "ptz-preset" },
      goBtn,
      editing
        ? h(
            "span",
            { class: "ptz-preset-tools" },
            h("button", { class: "btn icon-only ghost", type: "button", "aria-label": `把「${p.name}」覆寫成目前位置`, title: "覆寫成目前位置", onclick: () => overwrite(p) }, icon("crosshair", 18)),
            h("button", { class: "btn icon-only ghost danger", type: "button", "aria-label": `刪除「${p.name}」`, title: "刪除", onclick: () => remove(p) }, icon("trash", 18)),
          )
        : null,
    );
  }

  function render() {
    el.hidden = !opts.admin && presets.length === 0;
    list.replaceChildren(...presets.map(row));
    list.hidden = presets.length === 0;
    empty.hidden = !opts.admin || presets.length > 0;
    editBtn.hidden = !opts.admin || presets.length === 0;
    editBtn.textContent = editing ? "完成" : "編輯";
    editBtn.setAttribute("aria-pressed", String(editing));
    el.dataset.editing = String(editing);
    const isFull = full();
    addBtn.hidden = !opts.admin;
    addBtn.disabled = isFull;
    addBtn.setAttribute("aria-describedby", "ptz-limit");
    limit.hidden = !opts.admin || !isFull;
    limit.textContent = isFull ? `已達上限（${opts.max} 個），請先刪除一個。` : "";
  }

  editBtn.addEventListener("click", () => {
    editing = !editing;
    render();
  });
  addBtn.addEventListener("click", add);
  render();
  return el;
}
