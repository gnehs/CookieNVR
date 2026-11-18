import { api } from "../api.ts";
import { errMsg, h, panel, panelSection, switchInput, switchRow, toast } from "../dom.ts";
import type { PageCtx } from "../router.ts";
import { state } from "../state.ts";
import { settingsLayout } from "./settings-shell.ts";

export async function settingsSystemPage(_ctx: PageCtx): Promise<Node> {
  const settings = await api.settings();
  const name = h("input", { type: "text", required: true, maxlength: 40 });
  name.value = settings.siteName;
  name.setAttribute("aria-label", "站點名稱");
  const rtsp = switchInput(settings.rtsp.externalEnabled);
  const error = h("p", { class: "form-error", role: "alert" });
  const save = h("button", { class: "btn primary", type: "submit" }, "儲存變更");
  const form = panel(
    { tag: "form", title: "系統", foot: [error, save] },
    panelSection("站點名稱", "顯示在介面左上角與瀏覽器分頁標題。", h("div", { class: "narrow" }, name)),
    panelSection(
      null,
      null,
      switchRow(rtsp, "對外 RTSP 轉發", "開啟後，VLC、其他 NVR 等外部裝置可用帳號密碼或 API Token 從 NVR 讀取串流。關閉不影響錄影。"),
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
      toast("已儲存");
    } catch (err) {
      error.textContent = errMsg(err);
    } finally {
      save.disabled = false;
    }
  });
  return settingsLayout("system", form);
}
