import type { CameraDto, ProbeResult, StreamInfo } from "../../src/api-types.ts";
import type { CameraConfig, CameraConnection } from "../../src/types.ts";
import { api } from "../api.ts";
import { badge, confirmDialog, copyButton, copyWithToast, emptyState, errMsg, field, h, icon, menuButton, panel, panelSection, switchInput, switchRow, tiles, toast } from "../dom.ts";
import { cameraStatus } from "../health.ts";
import { navigate, type PageCtx } from "../router.ts";
import { state } from "../state.ts";
import { settingsLayout } from "./settings-shell.ts";

/** 網址裡的主機名稱，不含帳密與路徑 */
function hostOf(url: string): string {
  try {
    return new URL(url.replace(/^rtsps?:/i, "http:")).hostname;
  } catch {
    return "";
  }
}

function statusBadge(cam: CameraDto): HTMLElement {
  const st = cameraStatus(cam);
  return badge(st.label, st.tone);
}

export async function settingsCamerasPage(ctx: PageCtx): Promise<Node> {
  const box = h("div");
  const count = h("span", { class: "hint num" });
  const load = async () => {
    const cams = await api.cameras();
    if (!ctx.isCurrent()) return;
    count.textContent = cams.length ? `共 ${cams.length} 台` : "";
    box.replaceChildren(
      cams.length === 0
        ? emptyState(
            "還沒有攝影機",
            "支援 Tapo 與任何有 RTSP 的攝影機，加入後就會自動開始錄影。",
            h("a", { class: "btn primary", href: "#/settings/cameras/new" }, icon("plus"), "新增攝影機"),
            "camera",
          )
        : h("div", { class: "row-list", role: "list" }, cams.map((c) => row(c, load))),
    );
  };
  await load();
  ctx.every(5000, () => void load().catch(() => {}));
  return settingsLayout(
    "cameras",
    panel({ actions: [count, h("a", { class: "btn primary small", href: "#/settings/cameras/new" }, icon("plus", 15), "新增攝影機")] }, box),
  );
}

function row(cam: CameraDto, reload: () => Promise<void>): HTMLElement {
  const c = cam.config;
  const toggle = async () => {
    try {
      await api.updateCamera(cam.id, { ...c, enabled: !c.enabled });
      toast(c.enabled ? `已停用「${c.name}」` : `已啟用「${c.name}」`);
      await reload();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const remove = async () => {
    if (!(await confirmDialog(`刪除「${c.name}」？`, "會停止錄影並移除這台攝影機。已錄的影片不會馬上刪除，但之後無法再從這裡回放。", { confirmLabel: "刪除", danger: true }))) return;
    try {
      await api.deleteCamera(cam.id);
      toast(`已刪除「${c.name}」`);
      await reload();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const isTapo = c.connection.type === "tapo";
  const where = c.connection.type === "tapo" ? `Tapo・${c.connection.host}` : `RTSP・${hostOf(c.connection.mainUrl) || "自訂網址"}`;
  const edit = `#/settings/cameras/${encodeURIComponent(cam.id)}`;
  return h(
    "div",
    { class: "row-item cam-row", role: "listitem" },
    h(
      "a",
      { class: "row-main row-link", href: edit },
      h("span", { class: "row-ico" }, icon(isTapo ? "tapo" : "link", 18)),
      h("span", { class: "row-text" }, h("b", { class: "truncate" }, c.name), h("small", { class: "truncate" }, where)),
    ),
    statusBadge(cam),
    h(
      "div",
      { class: "row-actions" },
      h("a", { class: "btn small edit-btn", href: edit, "aria-label": `編輯「${c.name}」` }, "編輯"),
      menuButton(`「${c.name}」的更多動作`, [
        { label: "編輯", icon: "edit", onSelect: () => navigate(edit.slice(1)) },
        { label: "複製串流網址", icon: "copy", onSelect: () => void copyWithToast(cam.rtsp.main, "串流網址") },
        cam.rtsp.sub ? { label: "複製低畫質串流網址", icon: "copy", onSelect: () => void copyWithToast(cam.rtsp.sub!, "低畫質串流網址") } : null,
        { label: c.enabled ? "停用" : "啟用", icon: "power", onSelect: () => void toggle() },
        { label: "刪除", icon: "trash", danger: true, onSelect: () => void remove() },
      ]),
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

type FieldKey = keyof FormState;

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

function toConnection(s: FormState): { conn: CameraConnection } | { error: string; field: FieldKey } {
  if (s.type === "tapo") {
    if (!s.tapoHost.trim()) return { error: "請填寫相機的 IP 位址", field: "tapoHost" };
    if (!s.tapoUser.trim()) return { error: "請填寫相機帳號", field: "tapoUser" };
    if (!s.tapoPass) return { error: "請填寫相機密碼", field: "tapoPass" };
    return { conn: { type: "tapo", host: s.tapoHost.trim(), username: s.tapoUser.trim(), password: s.tapoPass } };
  }
  const main = s.mainUrl.trim();
  if (!/^rtsps?:\/\/\S+$/i.test(main)) return { error: "請填寫以 rtsp:// 開頭的串流網址", field: "mainUrl" };
  const sub = s.subUrl.trim();
  if (sub && !/^rtsps?:\/\/\S+$/i.test(sub)) return { error: "低畫質串流網址需以 rtsp:// 開頭", field: "subUrl" };
  const conn: CameraConnection = { type: "rtsp", mainUrl: main, transport: s.transport };
  if (sub) conn.subUrl = sub;
  if (s.onvifOn) {
    const port = Number(s.ovPort);
    if (!s.ovHost.trim()) return { error: "請填寫 ONVIF 主機", field: "ovHost" };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "ONVIF 連接埠需為 1 到 65535 的數字", field: "ovPort" };
    conn.onvif = { host: s.ovHost.trim(), port, username: s.ovUser, password: s.ovPass };
  }
  return { conn };
}

function quality(w: number): string {
  if (w >= 3800) return "4K";
  if (w >= 2500) return "2K";
  if (w >= 1900) return "1080p";
  if (w >= 1260) return "720p";
  return "";
}

function streamLine(s: StreamInfo): string {
  const q = quality(s.width);
  return [`${q ? `${q}（${s.width}×${s.height}）` : `${s.width}×${s.height}`}`, `${Math.round(s.fps * 10) / 10} fps`, s.videoCodec.toUpperCase().replace("HEVC", "H.265").replace("H264", "H.264"), s.audioCodec ? "有聲音" : "無聲音"].join("・");
}

/** 後端的錯誤已是中文；把「主碼流：」換成介面上的說法，ffmpeg 原文留給「複製錯誤內容」 */
function explainProbe(error: string): string {
  const msg = error.replace(/^主碼流：/, "").replace(/^子碼流：/, "低畫質串流：");
  return msg.startsWith("無法讀取串流：") ? "讀不到影像，請確認串流網址正確、相機的 RTSP 功能已開啟。" : msg;
}

function describeConn(conn: CameraConnection): string {
  return conn.type === "tapo" ? `Tapo，主機 ${conn.host}` : `RTSP，主機 ${hostOf(conn.mainUrl)}，傳輸 ${conn.transport.toUpperCase()}${conn.subUrl ? "，有低畫質串流" : ""}${conn.onvif ? "，有 ONVIF" : ""}`;
}

export async function cameraFormPage(ctx: PageCtx, id: string | null): Promise<Node> {
  let existing: CameraDto | null = null;
  if (id) {
    existing = (await api.cameras()).find((c) => c.id === id) ?? null;
    if (!existing) throw new Error("找不到這台攝影機，可能已經被刪除。");
  }
  const welcome = !existing && ctx.query.get("welcome") === "1";
  const listHref = welcome ? "#/cameras" : "#/settings/cameras";
  const s = fromConfig(existing?.config ?? null);
  const connKey = (st: FormState) => {
    const r = toConnection(st);
    return "conn" in r ? JSON.stringify(r.conn) : null;
  };
  const savedKey = existing ? connKey(s) : null;

  const inputs = new Map<FieldKey, HTMLInputElement>();
  const bind = (key: FieldKey, input: HTMLInputElement) => {
    inputs.set(key, input);
    input.name = key;
    input.value = String(s[key]);
    input.addEventListener("input", () => {
      (s as any)[key] = input.value;
      input.removeAttribute("aria-invalid");
      refresh();
    });
    return input;
  };
  const text = (key: FieldKey, attrs: Record<string, unknown> = {}) =>
    bind(key, h("input", { type: "text", autocomplete: "off", spellcheck: "false", autocapitalize: "off", ...attrs }));
  const secret = (key: FieldKey) => bind(key, h("input", { type: "password", autocomplete: "new-password" }));
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
      { value: "tapo", label: "Tapo", desc: "只要填 IP 與相機帳號", icon: "tapo" },
      { value: "rtsp", label: "其他攝影機", desc: "任何支援 RTSP 的攝影機", icon: "link" },
    ],
    s.type,
    (v) => {
      s.type = v;
      refresh();
    },
  );

  const tapoSection = h(
    "div",
    { class: "form" },
    h(
      "p",
      { class: "callout" },
      icon("info"),
      h("span", null, "帳號密碼請在 Tapo App 的「進階設定 → 相機帳戶」建立，", h("b", null, "不是"), " TP-Link 雲端帳號。"),
    ),
    field("相機 IP 位址", text("tapoHost", { placeholder: "例如 192.168.1.50", inputmode: "decimal" }), "建議在路由器把這個位址固定下來。"),
    h("div", { class: "field-row" }, field("相機帳號", text("tapoUser")), field("相機密碼", secret("tapoPass"))),
  );

  const rtspSection = h(
    "div",
    { class: "form" },
    field("串流網址", text("mainUrl", { placeholder: "rtsp://帳號:密碼@192.168.1.60:554/stream1", inputmode: "url" }), "以 rtsp:// 開頭，通常寫在相機的說明書或 App 裡。帳號密碼可以直接寫在網址中。"),
    field("低畫質串流網址（選填）", text("subUrl", { placeholder: "rtsp://…/stream2", inputmode: "url" }), "有的話，首頁預覽與動作偵測會更省資源。"),
  );

  const onvifFields = h(
    "div",
    { class: "form" },
    h("div", { class: "field-row" }, field("ONVIF 主機", text("ovHost", { placeholder: "192.168.1.60" })), field("連接埠", text("ovPort", { inputmode: "numeric" }))),
    h("div", { class: "field-row" }, field("ONVIF 帳號", text("ovUser")), field("ONVIF 密碼", secret("ovPass"))),
  );
  const transportTiles = tiles(
    "傳輸方式",
    [
      { value: "tcp", label: "TCP", desc: "建議，穩定不掉畫面" },
      { value: "udp", label: "UDP", desc: "延遲較低，網路不穩時容易花屏" },
    ],
    s.transport,
    (v) => {
      s.transport = v;
      refresh();
    },
  );
  const rtspAdvanced = h(
    "div",
    { class: "form" },
    h("div", { class: "field" }, h("span", { class: "legend" }, "傳輸方式"), transportTiles),
    check("onvifOn", "使用 ONVIF", "可以控制鏡頭轉向，並接收相機自己偵測到的事件。"),
    onvifFields,
  );
  const advanced = h(
    "details",
    { class: "disclosure" },
    h("summary", null, icon("chevron", 16), "進階設定", h("small", null, "大多數情況不需要調整")),
    h(
      "div",
      { class: "disclosure-body" },
      rtspAdvanced,
      h("div", { class: "switch-list" }, check("recDirect", "錄影直接連到相機", "影像服務出問題時錄影不受影響，但會多佔用相機一條連線。")),
    ),
  );
  if (s.type === "rtsp" && (s.transport !== "tcp" || s.onvifOn) || s.recDirect) advanced.open = true;

  const name = text("name", { placeholder: "例如：客廳、前門", maxlength: 60 });
  const result = h("div", { "aria-live": "polite" });
  const errorEl = h("p", { class: "form-error", role: "alert" });
  const saveLabel = h("span");
  const saveBtn = h("button", { class: "btn primary", type: "submit" }, saveLabel);

  const needsTest = () => !existing || connKey(s) !== savedKey;
  function refresh() {
    tapoSection.hidden = s.type !== "tapo";
    rtspSection.hidden = s.type !== "rtsp";
    rtspAdvanced.hidden = s.type !== "rtsp";
    onvifFields.hidden = !s.onvifOn;
    if (saveBtn.getAttribute("aria-busy") !== "true") saveLabel.textContent = needsTest() ? "測試並儲存" : "儲存變更";
  }

  const fail = (message: string, key?: FieldKey) => {
    errorEl.textContent = message;
    const input = key && inputs.get(key);
    if (input) {
      input.setAttribute("aria-invalid", "true");
      if (key === "ovHost" || key === "ovPort") advanced.open = true;
      input.focus();
    }
  };

  const welcomeNote = welcome
    ? h(
        "div",
        { class: "callout ok welcome" },
        icon("check-circle"),
        h("div", null, h("b", null, `歡迎使用 ${state.siteName}`), h("p", null, "先加入第一台攝影機。測試成功後會直接儲存，並馬上開始錄影。")),
      )
    : null;

  const form = panel(
    {
      tag: "form",
      class: "sticky-foot",
      title: existing ? `編輯「${existing.config.name}」` : welcome ? "新增第一台攝影機" : "新增攝影機",
      back: listHref,
      foot: [errorEl, h("a", { class: "btn", href: listHref }, welcome ? "稍後再說" : "取消"), saveBtn],
    },
    welcomeNote ? h("div", { class: "panel-section" }, welcomeNote) : null,
    panelSection(null, null, h("div", { class: "narrow" }, field("名稱", name, "會顯示在首頁與錄影頁。"))),
    panelSection("攝影機類型", null, typeTiles, tapoSection, rtspSection),
    panelSection(
      "錄影",
      null,
      h(
        "div",
        { class: "switch-list" },
        check("recEnabled", "全天候錄影"),
        check("recAudio", "錄下聲音"),
        existing ? check("enabled", "啟用這台攝影機", "停用後不看畫面也不錄影，但保留設定。") : null,
      ),
    ),
    advanced,
    h("div", { class: "panel-section result-slot" }, result),
  );
  const resultSlot = form.querySelector<HTMLElement>(".result-slot")!;
  resultSlot.hidden = true;

  const showFailure = (conn: CameraConnection, error: string) => {
    resultSlot.hidden = false;
    result.replaceChildren(
      h(
        "div",
        { class: "callout bad", role: "alert" },
        icon("alert"),
        h(
          "div",
          { style: "flex:1;min-width:0" },
          h("b", null, "連不上這台攝影機，所以還沒儲存"),
          h("p", null, explainProbe(error)),
          h(
            "div",
            { class: "form-actions", style: "margin-top:10px" },
            copyButton("複製錯誤內容", () => `CookieNVR 測試攝影機連線失敗\n攝影機：${describeConn(conn)}\n錯誤：${error}\n（帳號密碼已省略）`, { class: "small", done: "已複製錯誤內容，可以貼給 AI 或技術人員" }),
          ),
        ),
      ),
    );
    resultSlot.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.textContent = "";
    if (!s.name.trim()) return fail("請幫這台攝影機取個名稱", "name");
    const r = toConnection(s);
    if ("error" in r) return fail(r.error, r.field);
    const config: CameraConfig = {
      name: s.name.trim(),
      enabled: s.enabled,
      connection: r.conn,
      record: { enabled: s.recEnabled, audio: s.recAudio, direct: s.recDirect },
    };
    const testing = needsTest();
    // 上一次的失敗訊息在重新測試時先收起來，免得跟「正在測試」同時出現
    resultSlot.hidden = true;
    saveBtn.setAttribute("aria-busy", "true");
    saveBtn.disabled = true;
    saveLabel.replaceChildren(h("span", { class: "spin", "aria-hidden": "true" }), testing ? " 正在測試連線…" : " 儲存中…");
    try {
      let probe: ProbeResult | null = null;
      if (testing) {
        probe = await api.testCamera(r.conn);
        if (!probe.ok) {
          showFailure(r.conn, probe.error);
          return;
        }
      }
      resultSlot.hidden = true;
      const saved = existing ? await api.updateCamera(existing.id, config) : await api.createCamera(config);
      if (!ctx.isCurrent()) return;
      if (!probe?.ok) {
        toast(`已儲存「${saved.config.name}」`);
        navigate("/settings/cameras");
        return;
      }
      const view = successView(saved, probe, !existing, welcome);
      form.replaceWith(view);
      // 送出按鈕已經不在畫面上，焦點移到結果標題，螢幕閱讀器會念出「已加入」
      const title = view.querySelector<HTMLElement>(".panel-head h2");
      if (title) {
        title.tabIndex = -1;
        title.focus({ preventScroll: true });
      }
      window.scrollTo(0, 0);
    } catch (err) {
      fail(errMsg(err));
    } finally {
      saveBtn.removeAttribute("aria-busy");
      saveBtn.disabled = false;
      refresh();
    }
  });

  refresh();
  if (!existing) queueMicrotask(() => matchMedia("(pointer: fine)").matches && name.focus());
  // 第一次使用的引導不需要設定分頁列，畫面只留這張表單
  return welcome ? h("div", { class: "onboard" }, form) : settingsLayout("cameras", form);
}

function successView(cam: CameraDto, probe: Extract<ProbeResult, { ok: true }>, created: boolean, welcome: boolean): HTMLElement {
  const c = cam.config;
  const primary = created
    ? h("a", { class: "btn primary", href: "#/cameras" }, "查看畫面", icon("arrow-right", 16))
    : h("a", { class: "btn primary", href: "#/settings/cameras" }, "完成");
  const view = panel(
    {
      title: created ? `已加入「${c.name}」` : `已儲存「${c.name}」`,
      foot: [created && !welcome ? h("a", { class: "btn", href: "#/settings/cameras" }, "回到攝影機列表") : null, created ? h("a", { class: "btn", href: "#/settings/cameras/new" }, icon("plus", 16), "再加一台") : null, primary],
    },
    h(
      "div",
      { class: "panel-section success" },
      h(
        "div",
        { class: "success-shot" },
        probe.snapshotJpegBase64
          ? h("img", { alt: `${c.name} 的快照`, src: `data:image/jpeg;base64,${probe.snapshotJpegBase64}`, width: "640", height: "360" })
          : h("span", { class: "cam-ph" }, icon("camera", 28)),
      ),
      h(
        "div",
        { class: "success-text" },
        h("p", { class: "success-lead" }, icon("check-circle", 18), c.enabled && c.record.enabled ? "連線成功，已經開始錄影。" : "連線成功。"),
        h(
          "dl",
          { class: "spec" },
          h("dt", null, "高畫質"),
          h("dd", null, streamLine(probe.main)),
          h("dt", null, "低畫質"),
          h("dd", null, probe.sub ? streamLine(probe.sub) : "沒有，預覽會改用高畫質縮小"),
        ),
      ),
    ),
  );
  view.classList.add("page-enter");
  return view;
}
