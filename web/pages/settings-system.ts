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
  const homekit = switchInput(settings.homekit.enabled);
  const error = h("p", { class: "form-error", role: "alert" });
  const save = h("button", { class: "btn primary", type: "submit" }, "儲存變更");
  const form = panel(
    { tag: "form", foot: [error, save] },
    panelSection(null, null, h("div", { class: "narrow" }, field("站點名稱", name, "顯示在登入頁、側欄與瀏覽器分頁標題。"))),
    panelSection(
      null,
      null,
      switchRow(rtsp, "讓其他 App 讀取攝影機畫面", "開啟後，家裡其他裝置上的影音或智慧家庭 App 也能看到即時畫面。不影響錄影。"),
      h(
        "details",
        { class: "more" },
        h("summary", null, "怎麼使用？"),
        h(
          "p",
          null,
          "每台攝影機的串流網址在「攝影機 → 編輯 → 進階設定」裡可以複製。像 VLC、Home Assistant 或另一套 NVR 這類 App 連線時，用你的帳號密碼，或在「帳號 → 連接其他 App」為它建立一組密鑰（API Token）。",
        ),
      ),
    ),
    panelSection(
      null,
      null,
      switchRow(homekit, "Apple 家庭（實驗性）", "讓攝影機加入 iPhone 的「家庭」App。開啟後，到每台攝影機的設定裡加入。"),
      h(
        "details",
        { class: "more" },
        h("summary", null, "使用前要知道"),
        h(
          "p",
          null,
          "iPhone 是在家裡的網路上找到攝影機的，所以 CookieNVR 的容器要用 host 網路（或給它自己的區網 IP）。要收到動作通知、在外面看畫面，家裡要有當作家庭中樞的 Apple TV、HomePod 或 iPad；想讓 Apple 保存動作片段，還要有含安全錄影的 iCloud+ 方案。這是實驗性功能，畫質與錄影是否成功以實際使用為準。",
        ),
      ),
    ),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    if (!name.value.trim()) return void (error.textContent = "請填寫站點名稱");
    save.disabled = true;
    try {
      const res = await api.updateSettings({ siteName: name.value.trim(), rtsp: { externalEnabled: rtsp.checked }, homekit: { ...settings.homekit, enabled: homekit.checked } });
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
