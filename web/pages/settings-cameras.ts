import type { CameraDto, ProbeResult, StreamInfo } from "../../src/api-types.ts";
import type { CameraConfig, CameraConnection } from "../../src/types.ts";
import { api } from "../api.ts";
import { badge, confirmDialog, copyWithToast, emptyState, errMsg, field, h, icon, panel, panelSection, switchInput, switchRow, tiles, toast } from "../dom.ts";
import { navigate, type PageCtx } from "../router.ts";
import { settingsLayout } from "./settings-shell.ts";

export async function settingsCamerasPage(ctx: PageCtx): Promise<Node> {
  const box = h("div");
  const count = h("span", { class: "hint" });
  const load = async () => {
    const cams = await api.cameras();
    if (!ctx.isCurrent()) return;
    count.textContent = cams.length ? `${cams.length} 台` : "";
    box.replaceChildren(
      cams.length === 0
        ? h("div", { style: "padding:16px" }, emptyState("還沒有攝影機", "點右上角新增，支援 Tapo 與通用 RTSP。", undefined, "camera"))
        : h("div", { class: "row-list" }, cams.map((c) => row(c, load))),
    );
  };
  await load();
  ctx.every(5000, () => void load().catch(() => {}));
  return settingsLayout(
    "cameras",
    panel(
      { title: "攝影機", actions: [count, h("a", { class: "btn primary small", href: "#/settings/cameras/new" }, icon("plus", 15), "新增攝影機")] },
      box,
    ),
  );
}

function row(cam: CameraDto, reload: () => Promise<void>): HTMLElement {
  const c = cam.config;
  const toggle = async () => {
    try {
      await api.updateCamera(cam.id, { ...c, enabled: !c.enabled });
      toast(c.enabled ? "已停用" : "已啟用");
      await reload();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const remove = async () => {
    if (!(await confirmDialog(`刪除「${c.name}」？`, "會停止錄影並移除這台攝影機的設定。已錄的影片檔不會立刻刪除，但無法再從介面回放。", { confirmLabel: "刪除", danger: true }))) return;
    try {
      await api.deleteCamera(cam.id);
      toast("已刪除");
      await reload();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const isTapo = c.connection.type === "tapo";
  return h(
    "div",
    { class: "row-item" },
    h(
      "div",
      { class: "row-main" },
      h("span", { class: "row-ico" }, icon(isTapo ? "tapo" : "link", 18)),
      h("div", { class: "row-text" }, h("b", null, c.name), h("small", null, c.connection.type === "tapo" ? `Tapo · ${c.connection.host}` : "通用 RTSP")),
    ),
    h(
      "div",
      { class: "badges" },
      !c.enabled
        ? badge("已停用")
        : [badge(cam.online ? "上線" : "離線", cam.online ? "ok" : "warn"), badge(c.record.enabled ? (cam.recording ? "錄影中" : "未在錄影") : "錄影關閉", cam.recording ? "bad" : "muted")],
    ),
    h(
      "div",
      { class: "row-actions" },
      h("button", { class: "btn small", type: "button", onclick: () => copyWithToast(cam.rtsp.main, "主碼流網址") }, icon("copy", 15), "主碼流"),
      cam.rtsp.sub ? h("button", { class: "btn small", type: "button", onclick: () => copyWithToast(cam.rtsp.sub!, "子碼流網址") }, icon("copy", 15), "子碼流") : null,
      h("a", { class: "btn small", href: `#/settings/cameras/${encodeURIComponent(cam.id)}` }, icon("edit", 15), "編輯"),
      h("button", { class: "btn small", type: "button", onclick: toggle }, c.enabled ? "停用" : "啟用"),
      h("button", { class: "btn small icon-only danger", type: "button", "aria-label": `刪除 ${c.name}`, onclick: remove }, icon("trash", 15)),
    ),
  );
}

interface FormState {
  type: "tapo" | "rtsp";
  name: string;
  enabled: boolean;
  tapoHost: string;
  tapoUser: string;
  tapoPass: string;
  mainUrl: string;
  subUrl: string;
  transport: "tcp" | "udp";
  onvifOn: boolean;
  ovHost: string;
  ovPort: string;
  ovUser: string;
  ovPass: string;
  recEnabled: boolean;
  recAudio: boolean;
  recDirect: boolean;
}

function fromConfig(c: CameraConfig | null): FormState {
  const base: FormState = {
    type: "tapo", name: "", enabled: true,
    tapoHost: "", tapoUser: "", tapoPass: "",
    mainUrl: "", subUrl: "", transport: "tcp",
    onvifOn: false, ovHost: "", ovPort: "80", ovUser: "", ovPass: "",
    recEnabled: true, recAudio: true, recDirect: false,
  };
  if (!c) return base;
  base.name = c.name;
  base.enabled = c.enabled;
  base.recEnabled = c.record.enabled;
  base.recAudio = c.record.audio;
  base.recDirect = c.record.direct;
  const conn = c.connection;
  if (conn.type === "tapo") {
    base.type = "tapo";
    base.tapoHost = conn.host;
    base.tapoUser = conn.username;
    base.tapoPass = conn.password;
  } else {
    base.type = "rtsp";
    base.mainUrl = conn.mainUrl;
    base.subUrl = conn.subUrl ?? "";
    base.transport = conn.transport;
    if (conn.onvif) {
      base.onvifOn = true;
      base.ovHost = conn.onvif.host;
      base.ovPort = String(conn.onvif.port);
      base.ovUser = conn.onvif.username;
      base.ovPass = conn.onvif.password;
    }
  }
  return base;
}

function toConnection(s: FormState): { conn: CameraConnection } | { error: string } {
  if (s.type === "tapo") {
    if (!s.tapoHost.trim()) return { error: "請填寫相機 IP" };
    if (!s.tapoUser.trim() || !s.tapoPass) return { error: "請填寫相機帳號與密碼" };
    return { conn: { type: "tapo", host: s.tapoHost.trim(), username: s.tapoUser.trim(), password: s.tapoPass } };
  }
  const main = s.mainUrl.trim();
  if (!/^rtsps?:\/\/\S+$/i.test(main)) return { error: "主碼流網址必填，且需以 rtsp:// 開頭" };
  const sub = s.subUrl.trim();
  if (sub && !/^rtsps?:\/\/\S+$/i.test(sub)) return { error: "子碼流網址需以 rtsp:// 開頭" };
  const conn: CameraConnection = { type: "rtsp", mainUrl: main, transport: s.transport };
  if (sub) conn.subUrl = sub;
  if (s.onvifOn) {
    const port = Number(s.ovPort);
    if (!s.ovHost.trim()) return { error: "請填寫 ONVIF 主機" };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "ONVIF port 需為 1 到 65535" };
    conn.onvif = { host: s.ovHost.trim(), port, username: s.ovUser, password: s.ovPass };
  }
  return { conn };
}

function describeStream(label: string, s: StreamInfo): HTMLElement {
  return h(
    "div",
    null,
    h("h4", null, label),
    h(
      "dl",
      null,
      h("dt", null, "影像"), h("dd", null, s.videoCodec.toUpperCase()),
      h("dt", null, "解析度"), h("dd", null, `${s.width} × ${s.height}`),
      h("dt", null, "幀率"), h("dd", null, `${Math.round(s.fps * 10) / 10} fps`),
      h("dt", null, "音訊"), h("dd", null, s.audioCodec ? s.audioCodec.toUpperCase() : "無"),
    ),
  );
}

export async function cameraFormPage(_ctx: PageCtx, id: string | null): Promise<Node> {
  let existing: CameraDto | null = null;
  if (id) {
    existing = (await api.cameras()).find((c) => c.id === id) ?? null;
    if (!existing) throw new Error("找不到這台攝影機");
  }
  const s = fromConfig(existing?.config ?? null);
  const initialKey = existing ? keyOf(s) : null;
  let testedKey: string | null = initialKey;

  function keyOf(st: FormState): string {
    const r = toConnection(st);
    return "conn" in r ? JSON.stringify(r.conn) : `invalid:${r.error}`;
  }

  const text = (key: keyof FormState, attrs: Record<string, unknown> = {}) => {
    const input = h("input", { type: "text", autocomplete: "off", spellcheck: "false", autocapitalize: "off", ...attrs });
    input.value = String(s[key]);
    input.addEventListener("input", () => {
      (s as any)[key] = input.value;
      refresh();
    });
    return input;
  };
  const secret = (key: keyof FormState, attrs: Record<string, unknown> = {}) => {
    const input = h("input", { type: "password", autocomplete: "new-password", ...attrs });
    input.value = String(s[key]);
    input.addEventListener("input", () => {
      (s as any)[key] = input.value;
      refresh();
    });
    return input;
  };
  const check = (key: "enabled" | "onvifOn" | "recEnabled" | "recAudio" | "recDirect", title: string, desc?: string) =>
    switchRow(
      switchInput(s[key], (v) => {
        s[key] = v;
        refresh();
      }),
      title,
      desc,
    );

  const typeTiles = tiles(
    "攝影機類型",
    [
      { value: "tapo", label: "Tapo", desc: "填 IP 與相機帳號，其餘自動推導", icon: "tapo" },
      { value: "rtsp", label: "通用 RTSP", desc: "任何支援 RTSP 的攝影機", icon: "link" },
    ],
    s.type,
    (v) => {
      s.type = v;
      refresh();
    },
  );

  const tapoNotes = h(
    "div",
    { class: "callout" },
    icon("info"),
    h(
      "div",
      null,
      h("b", null, "Tapo 前置準備"),
      h(
        "ul",
        null,
        h("li", null, "在 Tapo App 的「進階設定 → 相機帳戶」建立帳號與密碼，這組不是 TP-Link 雲端帳號。"),
        h("li", null, "Tapo 限制同時 RTSP 連線數。CookieNVR 預設只佔兩條（主、子碼流各一），HA、瀏覽器、HKSV 與外部裝置都從 NVR 的 RTSP 轉發接。錄影改為直連相機時，會多佔一條主碼流連線。"),
        h("li", null, "建議在路由器把相機 IP 固定。"),
      ),
    ),
  );

  const tapoSection = h(
    "div",
    { class: "form" },
    tapoNotes,
    field("相機 IP", text("tapoHost", { placeholder: "192.168.1.50", inputmode: "decimal" })),
    h("div", { class: "field-row" }, field("相機帳號", text("tapoUser", { autocomplete: "off" })), field("相機密碼", secret("tapoPass"))),
    h("p", { class: "hint" }, "主碼流、子碼流與 ONVIF（port 2020）會自動推導。"),
  );

  const onvifFields = h(
    "div",
    { class: "form" },
    h("div", { class: "field-row" }, field("ONVIF 主機", text("ovHost", { placeholder: "192.168.1.50" })), field("Port", text("ovPort", { inputmode: "numeric" }))),
    h("div", { class: "field-row" }, field("ONVIF 帳號", text("ovUser")), field("ONVIF 密碼", secret("ovPass"))),
  );
  const transportTiles = tiles(
    "傳輸方式",
    [
      { value: "tcp", label: "TCP", desc: "建議。穩定、不掉封包" },
      { value: "udp", label: "UDP", desc: "延遲較低，網路不穩時易花屏" },
    ],
    s.transport,
    (v) => {
      s.transport = v;
      refresh();
    },
  );
  const rtspSection = h(
    "div",
    { class: "form" },
    field("主碼流網址", text("mainUrl", { placeholder: "rtsp://帳號:密碼@192.168.1.60:554/stream1" }), "必填。帳密可直接寫在網址裡。"),
    field("子碼流網址", text("subUrl", { placeholder: "rtsp://…/stream2" }), "選填。留空時偵測會用主碼流縮小處理。"),
    h("div", { class: "field" }, h("span", { class: "legend" }, "傳輸方式"), transportTiles),
    check("onvifOn", "啟用 ONVIF", "填了就能使用 PTZ 與相機事件。"),
    onvifFields,
  );

  const name = text("name", { placeholder: "例如：客廳", maxlength: 60, autocomplete: "off" });

  const resultBox = h("div", { "aria-live": "polite" });
  const errorEl = h("p", { class: "form-error", role: "alert" });
  const testBtn = h("button", { class: "btn", type: "button" }, icon("activity"), "測試連線");
  const saveBtn = h("button", { class: "btn primary", type: "submit" }, existing ? "儲存變更" : "新增攝影機");
  const saveHint = h("small", { class: "hint", "aria-live": "polite" });

  function refresh() {
    tapoSection.hidden = s.type !== "tapo";
    rtspSection.hidden = s.type !== "rtsp";
    onvifFields.hidden = !s.onvifOn;
    const key = keyOf(s);
    const tested = testedKey === key;
    saveBtn.disabled = !tested || s.name.trim() === "";
    saveHint.textContent = tested ? (s.name.trim() ? "" : "請填寫名稱") : "連線資訊有變動，測試成功後才能儲存。";
  }

  testBtn.addEventListener("click", async () => {
    errorEl.textContent = "";
    const r = toConnection(s);
    if ("error" in r) {
      errorEl.textContent = r.error;
      return;
    }
    const key = JSON.stringify(r.conn);
    testBtn.disabled = true;
    resultBox.replaceChildren(h("div", { class: "loading" }, h("span", { class: "spin" }), "正在連線並分析碼流，最多需要十幾秒…"));
    try {
      const res: ProbeResult = await api.testCamera(r.conn);
      if (!res.ok) {
        testedKey = null;
        resultBox.replaceChildren(h("div", { class: "callout bad", role: "alert" }, icon("alert"), h("div", null, h("b", null, "測試失敗"), h("p", null, res.error))));
      } else {
        testedKey = key;
        resultBox.replaceChildren(
          h(
            "div",
            { class: "callout ok" },
            icon("check"),
            h(
              "div",
              { style: "flex:1" },
              h("b", null, "測試成功"),
              h(
                "div",
                { class: "probe", style: "margin-top:10px" },
                describeStream("主碼流", res.main),
                res.sub ? describeStream("子碼流", res.sub) : h("div", null, h("h4", null, "子碼流"), h("p", { class: "muted" }, "未提供")),
                res.snapshotJpegBase64 ? h("div", null, h("h4", null, "快照"), h("img", { alt: "相機快照", src: `data:image/jpeg;base64,${res.snapshotJpegBase64}` })) : null,
              ),
            ),
          ),
        );
      }
    } catch (e) {
      testedKey = null;
      resultBox.replaceChildren(h("div", { class: "callout bad", role: "alert" }, icon("alert"), h("p", null, errMsg(e))));
    } finally {
      testBtn.disabled = false;
      refresh();
    }
  });

  const form = panel(
    {
      tag: "form",
      class: "sticky-foot",
      title: existing ? `編輯「${existing.config.name}」` : "新增攝影機",
      back: "#/settings/cameras",
      foot: [saveHint, errorEl, h("a", { class: "btn", href: "#/settings/cameras" }, "取消"), saveBtn],
    },
    panelSection("名稱", "顯示在攝影機列表與錄影頁。", h("div", { class: "narrow" }, name)),
    panelSection("連線方式", null, typeTiles, tapoSection, rtspSection),
    panelSection("測試連線", "儲存前必須先測試成功，確認碼流可以讀取。", h("div", { class: "form-actions" }, testBtn), resultBox),
    panelSection(
      "啟用與錄影",
      null,
      h(
        "div",
        { class: "switch-list" },
        check("enabled", "啟用這台攝影機", "停用後會停止所有處理，但保留設定。"),
        check("recEnabled", "連續錄影"),
        check("recAudio", "錄製音訊"),
        check("recDirect", "錄影直連相機", "不經 RTSP 轉發層，轉發層出問題時錄影不受影響；但會多佔相機一條連線。"),
      ),
    ),
  );
  name.setAttribute("aria-label", "名稱");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.textContent = "";
    const r = toConnection(s);
    if ("error" in r) {
      errorEl.textContent = r.error;
      return;
    }
    if (!s.name.trim()) {
      errorEl.textContent = "請填寫名稱";
      name.focus();
      return;
    }
    const config: CameraConfig = {
      name: s.name.trim(),
      enabled: s.enabled,
      connection: r.conn,
      record: { enabled: s.recEnabled, audio: s.recAudio, direct: s.recDirect },
    };
    saveBtn.disabled = true;
    try {
      if (existing) await api.updateCamera(existing.id, config);
      else await api.createCamera(config);
      toast(existing ? "已儲存" : "已新增攝影機");
      navigate("/settings/cameras");
    } catch (err) {
      errorEl.textContent = errMsg(err);
      refresh();
    }
  });

  refresh();
  return settingsLayout("cameras", form);
}
