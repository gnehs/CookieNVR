import { api } from "../api.ts";
import { errMsg, field, h, toast } from "../dom.ts";
import type { PageCtx } from "../router.ts";
import { state } from "../state.ts";
import { settingsLayout } from "./settings-shell.ts";

export async function settingsSystemPage(_ctx: PageCtx): Promise<Node> {
  const settings = await api.settings();
  const name = h("input", { type: "text", required: true, maxlength: 40 });
  name.value = settings.siteName;
  const rtsp = h("input", { type: "checkbox", checked: settings.rtsp.externalEnabled });
  const error = h("p", { class: "form-error", role: "alert" });
  const save = h("button", { class: "btn primary", type: "submit" }, "儲存");
  const form = h(
    "form",
    { class: "form", novalidate: true },
    field("站點名稱", name, "顯示在介面左上角與瀏覽器分頁標題。"),
    h(
      "label",
      { class: "check" },
      rtsp,
      h("span", null, h("b", null, "對外 RTSP 轉發"), h("small", null, "開啟後，VLC、其他 NVR 等外部裝置可用帳號密碼或 API Token 從 NVR 讀取串流。關閉不影響錄影。")),
    ),
    error,
    save,
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
  return settingsLayout("system", "系統", form);
}
