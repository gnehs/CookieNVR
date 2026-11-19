import type { CameraDto, HomekitDto } from "../../src/api-types.ts";
import type { HomekitCameraConfig } from "../../src/types.ts";
import { api } from "../api.ts";
import { confirmDialog, errMsg, h, icon, panelSection, switchInput, switchRow, toast } from "../dom.ts";
import { encodeQr, qrSvgPath } from "../homekit/qr.ts";

const POLL_MS = 3_000;
const SVG = "http://www.w3.org/2000/svg";

export interface HomekitSettings {
  el: HTMLElement;
  /** What the form saves: the section applies changes on its own, the form must not undo them. */
  value(): HomekitCameraConfig | undefined;
}

/** "57725799" → "5772 5799", the grouping Apple prints on HomeKit labels. */
export function formatCode(code: string): string {
  const digits = code.replaceAll("-", "");
  return `${digits.slice(0, 4)} ${digits.slice(4)}`;
}

function qrCode(payload: string): SVGSVGElement {
  const matrix = encodeQr(payload, "M");
  const n = matrix.length;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `-4 -4 ${n + 8} ${n + 8}`);
  svg.setAttribute("class", "hk-qr");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "加入 Apple 家庭用的 QR code");
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(SVG, "rect");
  for (const [k, v] of [["x", "-4"], ["y", "-4"], ["width", String(n + 8)], ["height", String(n + 8)], ["class", "hk-qr-bg"]]) bg.setAttribute(k!, v!);
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", qrSvgPath(matrix));
  path.setAttribute("class", "hk-qr-fg");
  svg.append(bg, path);
  return svg;
}

function blockedReason(dto: HomekitDto): string | null {
  if (!dto.systemEnabled) return null;
  if (dto.check.state === "blocked") {
    return dto.check.reason === "not-h264"
      ? `這台攝影機的主畫面是 ${dto.check.videoCodec?.toUpperCase() ?? "不支援的格式"}，家庭 App 只支援 H.264。在攝影機的 App 裡把主畫面改成 H.264 後，就可以開啟。`
      : "讀到的主畫面沒有影像，無法加入。";
  }
  if (dto.check.state === "unknown") return "目前讀不到這台的畫面，等它連上後再開啟。";
  return null;
}

function requirements(): HTMLElement {
  return h(
    "details",
    { class: "more" },
    h("summary", null, "需要準備什麼？"),
    h(
      "ul",
      { class: "hk-needs" },
      h("li", null, h("b", null, "家庭中樞："), "家裡要有一台當作家庭中樞的 Apple TV、HomePod 或 iPad，才會在偵測到動作時通知你、在外面也能看。"),
      h("li", null, h("b", null, "iCloud+："), "想讓 Apple 幫你保存動作片段（安全錄影），要訂閱含這項服務的 iCloud+ 方案。不訂閱也能看即時畫面。"),
      h("li", null, h("b", null, "網路設定："), "iPhone 是在家裡的網路上「找」到攝影機的，所以 CookieNVR 的容器要用 host 網路（或給它自己的區網 IP）。"),
      h("li", null, "CookieNVR 自己的全天候錄影不受影響，家庭 App 裡的錄影設定只管 Apple 那邊。"),
    ),
  );
}

export function homekitSettings(camera: CameraDto): HomekitSettings {
  let dto: HomekitDto | null = null;
  let busy = false;
  let poll: ReturnType<typeof setTimeout> | null = null;
  const body = h("div", { class: "hk-body" }, h("p", { class: "hk-muted" }, h("span", { class: "spin", "aria-hidden": "true" }), " 正在檢查這台攝影機…"));
  const el = panelSection(
    null,
    null,
    h(
      "header",
      { class: "hk-head" },
      h("h3", null, "Apple 家庭", h("span", { class: "badge plain hk-beta" }, "實驗性")),
      h("p", null, "在 iPhone、iPad 或 Mac 的「家庭」App 裡看這台攝影機，有動作時收到通知。"),
    ),
    body,
  );

  function schedulePoll(): void {
    if (poll) clearTimeout(poll);
    poll = null;
    if (!dto?.enabled || !dto.systemEnabled || (dto.pairing?.paired && dto.status === "ready")) return;
    poll = setTimeout(async () => {
      if (!el.isConnected) return;
      try {
        dto = await api.homekit(camera.id);
        render();
      } catch {
        schedulePoll();
      }
    }, POLL_MS);
  }

  async function act(action: "enable" | "disable" | "reset"): Promise<void> {
    if (busy) return;
    busy = true;
    render();
    try {
      dto = await api.homekitAction(camera.id, action);
      if (action === "reset") toast("已重設配對，請用新的配對碼重新加入");
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      busy = false;
      render();
    }
  }

  function statusLine(d: HomekitDto): HTMLElement {
    if (d.status === "failed") {
      return h(
        "div",
        { class: "callout bad" },
        icon("alert", 16),
        h("p", null, "沒辦法讓家庭 App 找到這台攝影機。到「設定 → 狀態」按「複製診斷資訊」，可以看到原因。"),
      );
    }
    if (d.pairing?.paired) {
      return h("p", { class: "hk-state ok" }, icon("check", 16), h("span", null, h("b", null, "已加入家庭"), "可以在家庭 App 裡看畫面，也會收到動作通知。"));
    }
    if (d.status === "starting") return h("p", { class: "hk-state" }, h("span", { class: "spin", "aria-hidden": "true" }), h("span", null, "正在準備，幾秒後就能加入…"));
    return h("p", { class: "hk-state wait" }, h("span", { class: "hk-dot", "aria-hidden": "true" }), h("span", null, h("b", null, "等待加入"), "用 iPhone 掃描下面的 QR code。"));
  }

  function pairingCard(d: HomekitDto): HTMLElement | null {
    if (!d.pairing || d.pairing.paired || d.status === "failed") return null;
    return h(
      "div",
      { class: "hk-pair" },
      h("div", { class: "hk-qr-wrap" }, qrCode(d.pairing.setupUri)),
      h(
        "div",
        { class: "hk-pair-text" },
        h("p", { class: "hk-code-label" }, "配對碼"),
        h("p", { class: "hk-code", "aria-label": `配對碼 ${d.pairing.code.replaceAll("-", "").split("").join(" ")}` }, formatCode(d.pairing.code)),
        h(
          "ol",
          { class: "hk-steps" },
          h("li", null, "打開「家庭」App，點右上角的 ＋，選「加入配件」。"),
          h("li", null, "掃描左邊的 QR code。掃不到時選「更多選項」，點這台攝影機，再輸入配對碼。"),
          h("li", null, "出現「未認證的配件」時選「仍要加入」。"),
        ),
      ),
    );
  }

  function render(): void {
    if (!dto) return;
    const d = dto;
    const blocked = !d.enabled ? blockedReason(d) : null;
    const sw = switchInput(d.enabled && d.systemEnabled, (on) => void act(on ? "enable" : "disable"));
    sw.disabled = busy || !d.systemEnabled || (!d.enabled && blocked !== null);
    const parts: (Node | null)[] = [switchRow(sw, "加入 Apple 家庭", d.enabled && d.systemEnabled ? undefined : "開啟後會顯示配對用的 QR code。")];
    if (!d.systemEnabled) {
      parts.push(
        h(
          "p",
          { class: "hk-muted" },
          "要先到 ",
          h("a", { class: "text-link", href: "#/settings/system" }, "設定 → 系統"),
          " 開啟「Apple 家庭」，這裡才能使用。",
        ),
      );
    } else if (blocked) {
      parts.push(h("div", { class: "callout" }, icon("info", 16), h("p", null, blocked)));
    }
    if (d.systemEnabled && d.check.state === "ok" && d.check.warning === "keyframe-interval") {
      parts.push(
        h(
          "div",
          { class: "callout warn" },
          icon("alert", 16),
          h(
            "p",
            null,
            d.check.keyframeIntervalSec
              ? `這台每 ${d.check.keyframeIntervalSec} 秒才有一張完整畫面（關鍵幀），超過 Apple 要求的 4 秒，安全錄影可能失敗。建議在攝影機設定裡把關鍵幀間隔（I-frame）調到 4 秒以內。`
              : "這台的完整畫面（關鍵幀）間隔超過 4 秒，安全錄影可能失敗。建議在攝影機設定裡把關鍵幀間隔（I-frame）調到 4 秒以內。",
          ),
        ),
      );
    }
    if (d.enabled && d.systemEnabled) {
      parts.push(statusLine(d), pairingCard(d));
      if (d.pairing) {
        parts.push(
          h(
            "div",
            { class: "hk-actions" },
            h(
              "button",
              {
                class: "btn small",
                type: "button",
                disabled: busy,
                onclick: async () => {
                  const ok = await confirmDialog(
                    "重設配對？",
                    "家庭 App 裡的這台攝影機會失效，請先在家庭 App 移除它，再用新的配對碼重新加入。已錄在 CookieNVR 的影片不受影響。",
                    { confirmLabel: "重設配對", danger: true },
                  );
                  if (ok) await act("reset");
                },
              },
              icon("refresh", 15),
              "重設配對",
            ),
          ),
        );
      }
    }
    parts.push(requirements());
    body.replaceChildren(...parts.filter((p): p is Node => p !== null));
    schedulePoll();
  }

  void api.homekit(camera.id).then(
    (d) => {
      dto = d;
      render();
    },
    (e) => body.replaceChildren(h("div", { class: "callout bad" }, icon("alert", 16), h("p", null, errMsg(e)))),
  );

  return {
    el,
    value: () => (dto ? { enabled: dto.enabled } : camera.config.homekit),
  };
}
