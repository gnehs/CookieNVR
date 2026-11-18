import { api } from "../api.ts";
import { errMsg, field, h, panel, panelSection, switchInput, switchRow, toast } from "../dom.ts";
import type { PageCtx } from "../router.ts";
import { state } from "../state.ts";
import { settingsLayout } from "./settings-shell.ts";

export async function settingsSystemPage(_ctx: PageCtx): Promise<Node> {
  const settings = await api.settings();
  const name = h("input", { type: "text", required: true, maxlength: 40, autocomplete: "off", name: "siteName" });
  name.value = settings.siteName;
  const rtsp = switchInput(settings.rtsp.externalEnabled);
  const error = h("p", { class: "form-error", role: "alert" });
  const save = h("button", { class: "btn primary", type: "submit" }, "儲存變更");
  const form = panel(
    { tag: "form", foot: [error, save] },
    panelSection(null, null, h("div", { class: "narrow" }, field("站點名稱", name, "顯示在登入頁、側欄與瀏覽器分頁標題。"))),
    panelSection(
      null,
      null,
      switchRow(rtsp, "讓其他裝置讀取攝影機畫面", "開啟後，VLC、Home Assistant 或其他 NVR 可以用你的帳號或 API Token 讀取畫面。不影響錄影。"),
    ),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    if (!name.value.trim()) return void (error.textContent = "請填寫站點名稱");
    save.disabled = true;
    try {
      const res = await api.updateSettings({ siteName: name.value.trim(), rtsp: { externalEnabled: rtsp.checked } });
      state.siteName = res.siteName;
      document.title = res.siteName;
      window.dispatchEvent(new Event("sitenamechange"));
      toast("已儲存一般設定");
    } catch (err) {
      error.textContent = errMsg(err);
    } finally {
      save.disabled = false;
    }
  });
  return settingsLayout("system", form);
}
