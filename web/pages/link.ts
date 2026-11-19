import type { LinkRequestDto } from "../../src/api-types.ts";
import { api, ApiError } from "../api.ts";
import { brandMark, errMsg, h, icon } from "../dom.ts";
import { navigate, type PageCtx } from "../router.ts";
import { state } from "../state.ts";
import { isLocalAddress } from "../link-address.ts";

type View = "ask" | "approved" | "denied" | "expired" | "used";


function frame(...content: (Node | null)[]): HTMLElement {
  return h(
    "main",
    { class: "auth link-page" },
    h("div", { class: "brand" }, brandMark(), h("span", null, state.siteName)),
    h("section", { class: "card auth-card link-card" }, ...content),
  );
}

function outcome(tone: "ok" | "bad" | "muted", iconName: string, title: string, body: string): HTMLElement {
  return frame(
    h(
      "div",
      { class: "link-outcome", "data-tone": tone, role: "status" },
      h("span", { class: "link-outcome-ico" }, icon(iconName, 26)),
      h("h1", { class: "auth-title" }, title),
      h("p", null, body),
    ),
    h("a", { class: "btn", href: "#/cameras" }, "前往 CookieNVR"),
  );
}

function minutesLeft(deadline: number): string {
  const s = Math.max(0, Math.round((deadline - Date.now()) / 1000));
  return s >= 60 ? `${Math.ceil(s / 60)} 分鐘內有效` : `${s} 秒內有效`;
}

function codeEntry(error?: string): HTMLElement {
  const input = h("input", {
    type: "text",
    inputmode: "text",
    autocapitalize: "characters",
    autocomplete: "off",
    spellcheck: "false",
    maxlength: 12,
    placeholder: "XXXX-XXXX",
    class: "link-code-input",
    "aria-label": "連線代碼",
  });
  const err = h("p", { class: "form-error", role: "alert" }, error ?? "");
  const form = h("form", { class: "form", novalidate: true }, input, err, h("button", { class: "btn primary", type: "submit" }, "繼續"));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = input.value.toUpperCase().replace(/[^A-Z]/g, "");
    if (code.length !== 8) return void (err.textContent = "代碼是 8 個英文字母");
    navigate(`/link/${code.slice(0, 4)}-${code.slice(4)}`);
  });
  queueMicrotask(() => input.focus());
  return frame(
    h("header", null, h("h1", { class: "auth-title" }, "輸入連線代碼"), h("p", null, "代碼顯示在要連線的 App（例如 Home Assistant）畫面上。")),
    form,
  );
}

/** 核准頁：其他 App（例如 Home Assistant）要求連線時，使用者在這裡對照代碼後允許或拒絕 */
export async function linkPage(ctx: PageCtx): Promise<Node> {
  // 被其他網站用 iframe 嵌入時不顯示按鈕，避免點擊劫持
  if (window.top !== window.self) {
    return frame(
      h("header", null, h("h1", { class: "auth-title" }, "請直接開啟這個頁面"), h("p", null, "為了安全，連線請求只能在 CookieNVR 自己的分頁裡核准。")),
      h("a", { class: "btn primary", href: location.href, target: "_blank", rel: "noopener" }, "在新分頁開啟"),
    );
  }

  const raw = ctx.params.code;
  if (!raw) return codeEntry();

  let req: LinkRequestDto;
  try {
    req = await api.linkRequest(raw);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return codeEntry("找不到這組代碼，可能打錯了或已經過期");
    throw e;
  }

  const me = state.me!;
  // 用 NVR 給的剩餘秒數在本機倒數，瀏覽器時鐘不準也不影響
  const deadline = Date.now() + req.expiresIn * 1000;
  const root = h("div", { style: "display:contents" });
  const show = (view: View) => {
    if (view === "ask") return root.replaceChildren(ask());
    const next =
      view === "approved"
        ? outcome("ok", "check", "已允許", `回到 ${req.app}，它會自動完成設定。之後可以在「帳號 → 連接其他 App」隨時撤銷。`)
        : view === "denied"
          ? outcome("muted", "x", "已拒絕", `${req.app} 不會連線到 CookieNVR。`)
          : view === "used"
            ? outcome("ok", "check", "這個請求已經完成", `${req.app} 已經連線了，不需要再做什麼。`)
            : outcome("muted", "clock", "這個請求已經過期", `回到 ${req.app} 重新開始，會拿到一組新的代碼。`);
    root.replaceChildren(next);
  };

  const ask = (): HTMLElement => {
    const isAdmin = me.role === "admin";
    const left = h("span", null, minutesLeft(deadline));
    const err = h("p", { class: "form-error", role: "alert" });
    const allow = h("button", { class: "btn primary", type: "button" }, "允許");
    const deny = h("button", { class: "btn", type: "button" }, "拒絕");

    ctx.every(1000, () => {
      if (Date.now() >= deadline) show("expired");
      else left.textContent = minutesLeft(deadline);
    });
    // 頁面剛出現時先停用按鈕一下，避免被誘導連點時第二下剛好落在「允許」
    allow.disabled = deny.disabled = true;
    setTimeout(() => (allow.disabled = deny.disabled = false), 600);

    const act = async (decision: "approve" | "deny") => {
      allow.disabled = deny.disabled = true;
      err.textContent = "";
      try {
        req = await api.decideLink(raw, decision);
        show(decision === "approve" ? "approved" : "denied");
      } catch (e) {
        if (e instanceof ApiError && e.status === 410) return show("expired");
        if (e instanceof ApiError && e.status === 409) return show("used");
        err.textContent = errMsg(e);
        allow.disabled = deny.disabled = false;
      }
    };
    allow.addEventListener("click", () => void act("approve"));
    deny.addEventListener("click", () => void act("deny"));

    return frame(
      h("header", null, h("h1", { class: "auth-title" }, `允許「${req.app}」連線？`)),
      h(
        "div",
        { class: "link-code" },
        h("p", null, `確認和 ${req.app} 畫面上的代碼一樣`),
        h("output", { class: "link-code-value", translate: "no", "aria-label": `代碼 ${req.code.split("").join(" ")}` }, req.code),
      ),
      h(
        "div",
        { class: "link-grants" },
        h("p", null, `允許後，${req.app} 會以「${me.username}」的身分：`),
        h(
          "ul",
          null,
          h("li", null, icon("camera", 16), "看到所有攝影機的畫面和錄影"),
          h("li", null, icon("activity", 16), "在有動靜時收到通知"),
          h("li", null, icon("crosshair", 16), "轉動可以轉的鏡頭"),
          isAdmin
            ? h("li", null, icon("settings", 16), "開關錄影與偵測，也能變更所有設定（和你的管理員帳號一樣）")
            : h("li", { class: "link-grant-no" }, icon("lock", 16), "錄影與偵測開關不會出現（需要管理員帳號）"),
        ),
      ),
      h(
        "p",
        { class: "link-source" },
        icon("globe", 16),
        h("span", null, "請求來自 ", h("b", { translate: "no" }, req.ip)),
      ),
      isLocalAddress(req.ip)
        ? null
        : h(
            "div",
            { class: "callout warn" },
            icon("alert"),
            h("p", null, "這個請求不是從你家裡的網路送出的。除非你很確定，否則請按拒絕。"),
          ),
      err,
      h("div", { class: "link-actions" }, deny, allow),
      h("p", { class: "link-meta" }, left, h("br"), `如果不是你剛剛在 ${req.app} 裡按的，請按拒絕。`),
    );
  };

  const initial: View =
    req.status === "pending" ? "ask" : req.status === "denied" ? "denied" : req.status === "expired" ? "expired" : "used";
  show(initial);
  return root;
}
