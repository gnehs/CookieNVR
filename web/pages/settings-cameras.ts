import type { CameraDto, ProbeResult, StreamInfo } from "../../src/api-types.ts";
import type { CameraConfig, CameraConnection } from "../../src/types.ts";
import { api } from "../api.ts";
import { badge, copyButton, emptyState, errMsg, field, formatBytes, h, icon, menuButton, openDialog, PageError, panel, panelSection, switchInput, switchRow, tiles, toast } from "../dom.ts";
import { explainProbe, maskedField, type ProbeField } from "../camera-form-logic.ts";
import { cameraStatus } from "../health.ts";
import { navigate, type PageCtx } from "../router.ts";
import { state } from "../state.ts";
import { settingsLayout, settingsSubpage } from "./settings-shell.ts";

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
  const add = h("a", { class: "btn primary small", href: "#/settings/cameras/new" }, icon("plus", 15), "新增攝影機");
  const toolbar = h("div", { class: "list-toolbar" }, count, add);
  const load = async () => {
    const cams = await api.cameras();
    if (!ctx.isCurrent()) return;
    count.textContent = cams.length ? `共 ${cams.length} 台` : "";
    toolbar.hidden = cams.length === 0;
    box.replaceChildren(
      cams.length === 0
        ? emptyState(
            "還沒有攝影機",
            "支援 Tapo 與任何有 RTSP 的攝影機，加入後就會自動開始錄影。",
            h("a", { class: "btn primary", href: "#/settings/cameras/new" }, icon("plus"), "新增攝影機"),
            "camera",
          )
        : h("div", { class: "card row-list", role: "list" }, cams.map((c) => row(c, load))),
    );
  };
  await load();
  ctx.every(5000, () => void load().catch(() => {}));
  return settingsLayout("cameras", h("div", null, toolbar, box));
}

/** 不勾選時，刪除攝影機只移除設定；已錄的片段留在硬碟上，照保留天數與最低剩餘空間清除，但介面上已經沒有入口可以回放 */
async function keepMessage(): Promise<string> {
  const lead = "會停止錄影並移除這台攝影機。已錄的影片會留在硬碟上，但之後無法再回放，";
  try {
    const { continuousDays: c, eventDays: e } = (await api.settings()).retention;
    if (c === 0 && e === 0) return `${lead}而且保留天數設為不限，只有空間不夠時才會從最舊的開始刪除。在那之前會一直佔用空間。`;
    const days = (n: number) => (n === 0 ? "不限" : `${n} 天`);
    return `${lead}會繼續佔用空間，直到超過保留天數（連續錄影 ${days(c)}、事件片段 ${days(e)}）才自動刪除。`;
  } catch {
    return `${lead}會繼續佔用空間，直到超過保留天數才自動刪除。`;
  }
}

const PURGE_MESSAGE = "會停止錄影並移除這台攝影機，這台所有的錄影也會立刻永久刪除，無法復原。";

/** 回傳 null 表示取消；true 表示連同錄影一起刪除。這台沒有任何錄影（bytes === 0）時不顯示勾選項。 */
async function confirmDeleteCamera(name: string, bytes: number | undefined): Promise<boolean | null> {
  const keep = await keepMessage();
  const result = await openDialog<boolean>(`刪除「${name}」？`, (close) => {
    const text = h("p", { class: "dlg-text", "aria-live": "polite" }, keep);
    const confirm = h("button", { class: "btn danger solid", type: "button", autofocus: true }, "刪除攝影機");
    const purge = switchInput(false, (on) => {
      text.textContent = on ? PURGE_MESSAGE : keep;
      confirm.textContent = on ? "刪除攝影機與錄影" : "刪除攝影機";
    });
    confirm.addEventListener("click", () => close(purge.checked));
    return h(
      "div",
      null,
      text,
      bytes === 0 ? null : h("div", { class: "dlg-option" }, switchRow(purge, "同時刪除這台的錄影", bytes === undefined ? undefined : `會釋放 ${formatBytes(bytes)}`)),
      h("div", { class: "dlg-actions" }, h("button", { class: "btn", type: "button", onclick: () => close() }, "取消"), confirm),
    );
  });
  return result === undefined ? null : result;
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
    const usage = await api.system().then((s) => s.usage.find((u) => u.cameraId === cam.id)?.bytes ?? 0, () => undefined);
    const purge = await confirmDeleteCamera(c.name, usage);
    if (purge === null) return;
    try {
      await api.deleteCamera(cam.id, purge);
      toast(`已刪除「${c.name}」`);
      await reload();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return h(
    "div",
    { class: "row-item cam-row", role: "listitem" },
    // 整列都能點進編輯：連結的 ::after 蓋住整列，選單按鈕疊在上面
    h(
      "a",
      { class: "row-main row-link stretch", href: `#/settings/cameras/${encodeURIComponent(cam.id)}` },
      h("span", { class: "row-ico" }, icon(c.connection.type === "tapo" ? "tapo" : "link", 18)),
      h("span", { class: "row-text" }, h("b", { class: "truncate" }, c.name)),
    ),
    statusBadge(cam),
    h(
      "div",
      { class: "row-actions" },
      menuButton(`「${c.name}」的更多動作`, [
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

function describeConn(conn: CameraConnection): string {
  return conn.type === "tapo" ? `Tapo，主機 ${conn.host}` : `RTSP，主機 ${hostOf(conn.mainUrl)}，傳輸 ${conn.transport.toUpperCase()}${conn.subUrl ? "，有低畫質串流" : ""}${conn.onvif ? "，有 ONVIF" : ""}`;
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export type CameraFormMode = "welcome" | "new" | "edit";

export async function cameraFormPage(ctx: PageCtx, id: string | null, mode: CameraFormMode = id ? "edit" : "new"): Promise<Node> {
  let existing: CameraDto | null = null;
  if (id) {
    existing = (await api.cameras()).find((c) => c.id === id) ?? null;
    if (!existing) throw new PageError("找不到這台攝影機", "它可能已經被刪除了。", { label: "回到攝影機列表", href: "#/settings/cameras" });
  }
  const welcome = mode === "welcome";
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
      if (input.getAttribute("aria-invalid") === "true") clearErrors();
      refresh();
    });
    return input;
  };
  const text = (key: FieldKey, attrs: Record<string, unknown> = {}) =>
    bind(key, h("input", { type: "text", autocomplete: "off", spellcheck: "false", autocapitalize: "off", ...attrs }));
  const secret = (key: FieldKey) => bind(key, h("input", { type: "password", autocomplete: "new-password" }));
  /** 串流網址：沒聚焦時遮住網址裡的密碼，送出用的是 s[key]，不受畫面遮蔽影響 */
  const urlInput = (key: "mainUrl" | "subUrl", placeholder: string) => {
    const masked = maskedField(s[key]);
    const input = h("input", { type: "text", autocomplete: "off", spellcheck: "false", autocapitalize: "off", inputmode: "url", placeholder, name: key });
    inputs.set(key, input);
    input.value = masked.display();
    input.addEventListener("focus", () => {
      masked.focus();
      input.value = masked.display();
    });
    input.addEventListener("blur", () => {
      masked.blur();
      input.value = masked.display();
    });
    input.addEventListener("input", () => {
      masked.input(input.value);
      s[key] = masked.value();
      if (document.activeElement !== input) input.value = masked.display();
      if (input.getAttribute("aria-invalid") === "true") clearErrors();
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
      { value: "tapo", label: "Tapo", desc: "只要填 IP 與相機帳號", icon: "tapo" },
      { value: "rtsp", label: "其他攝影機", desc: "任何支援 RTSP 的攝影機", icon: "link" },
    ],
    s.type,
    (v) => {
      s.type = v;
      clearErrors();
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
    // 不用 inputmode="decimal"：iPhone 的數字鍵盤打不出主機名稱
    field("相機 IP 位址", text("tapoHost", { placeholder: "例如 192.168.1.50", inputmode: "url" }), "建議在路由器把這個位址固定下來。"),
    h("div", { class: "field-row" }, field("相機帳號", text("tapoUser")), field("相機密碼", secret("tapoPass"))),
  );

  const rtspSection = h(
    "div",
    { class: "form" },
    field("串流網址", urlInput("mainUrl", "rtsp://帳號:密碼@192.168.1.60:554/stream1"), "以 rtsp:// 開頭，通常寫在相機的說明書或 App 裡。帳號密碼可以直接寫在網址中。"),
    field("低畫質串流網址（選填）", urlInput("subUrl", "rtsp://…/stream2"), "有的話，首頁預覽與動作偵測會更省資源。"),
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
  const shareUrls = existing
    ? h(
        "div",
        { class: "field" },
        h("span", { class: "legend" }, "給其他 App 的串流網址"),
        h("small", { class: "hint" }, "在「設定 → 一般」開啟「讓其他 App 讀取攝影機畫面」後，VLC 或 Home Assistant 可以用這個網址看這台攝影機。"),
        h(
          "div",
          { class: "form-actions" },
          copyButton("複製串流網址", () => existing!.rtsp.main, { class: "small", done: "已複製串流網址" }),
          existing.rtsp.sub ? copyButton("複製低畫質串流網址", () => existing!.rtsp.sub!, { class: "small", done: "已複製低畫質串流網址" }) : null,
        ),
      )
    : null;
  const advanced = h(
    "details",
    { class: "disclosure" },
    h("summary", null, icon("chevron", 16), "進階設定", h("small", null, "大多數情況不需要調整")),
    h(
      "div",
      { class: "disclosure-body" },
      rtspAdvanced,
      h("div", { class: "switch-list" }, check("recDirect", "錄影直接連到相機", "影像服務出問題時錄影不受影響，但會多佔用相機一條連線。")),
      shareUrls,
    ),
  );
  if (s.type === "rtsp" && (s.transport !== "tcp" || s.onvifOn) || s.recDirect) advanced.open = true;

  const name = text("name", { placeholder: "例如：客廳、前門", maxlength: 60 });
  const summary = h("p", { class: "form-error", role: "alert" });
  const copySlot = h("span", { class: "copy-slot" });
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

  function clearErrors() {
    summary.textContent = "";
    copySlot.replaceChildren();
    for (const input of inputs.values()) {
      input.removeAttribute("aria-invalid");
      const err = document.getElementById(`${input.id}-err`);
      if (err) {
        err.remove();
        const rest = (input.getAttribute("aria-describedby") ?? "").split(" ").filter((t) => t && t !== err.id);
        if (rest.length) input.setAttribute("aria-describedby", rest.join(" "));
        else input.removeAttribute("aria-describedby");
      }
    }
  }

  /** 錯誤掛在欄位旁並標成錯誤，捲過去聚焦；also 是一起標紅但不另外寫字的欄位（例如帳號＋密碼） */
  function fieldError(key: FieldKey, message: string, also: FieldKey[] = []) {
    const input = inputs.get(key);
    if (!input) return;
    for (const k of [key, ...also]) inputs.get(k)?.setAttribute("aria-invalid", "true");
    const err = h("p", { class: "field-error", id: `${input.id}-err` }, icon("alert-circle", 15), h("span", null, message));
    input.closest(".field")!.append(err);
    input.setAttribute("aria-describedby", [input.getAttribute("aria-describedby"), err.id].filter(Boolean).join(" "));
    const details = input.closest("details");
    if (details) details.open = true;
    input.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    input.focus({ preventScroll: true });
  }

  const fail = (message: string, key?: FieldKey) => {
    clearErrors();
    if (key && inputs.has(key)) {
      fieldError(key, message);
      summary.textContent = "請修正標示的欄位";
    } else summary.textContent = message;
  };

  const showProbeFailure = (conn: CameraConnection, error: string) => {
    clearErrors();
    const help = explainProbe(error, s.type);
    const tapo = s.type === "tapo";
    const target: Record<NonNullable<ProbeField>, [FieldKey, FieldKey[]]> = {
      host: [tapo ? "tapoHost" : "mainUrl", []],
      url: [tapo ? "tapoHost" : "mainUrl", []],
      credentials: tapo ? ["tapoPass", ["tapoUser"]] : ["mainUrl", []],
      subUrl: ["subUrl", []],
    };
    summary.textContent = help.field ? "連不上這台攝影機，所以還沒儲存" : help.message;
    if (help.field) fieldError(target[help.field][0], help.message, target[help.field][1]);
    copySlot.replaceChildren(
      copyButton("複製錯誤內容", () => `CookieNVR 測試攝影機連線失敗\n攝影機：${describeConn(conn)}\n錯誤：${error}\n（帳號密碼已省略）`, { class: "small ghost", done: "已複製錯誤內容，可以貼給 AI 或技術人員" }),
    );
  };

  const form = panel(
    {
      tag: "form",
      class: "sticky-foot",
      foot: [h("div", { class: "foot-status" }, summary, copySlot), h("a", { class: "btn", href: listHref }, welcome ? "稍後再說" : "取消"), saveBtn],
    },
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
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors();
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
    saveBtn.setAttribute("aria-busy", "true");
    saveBtn.disabled = true;
    saveLabel.replaceChildren(h("span", { class: "spin", "aria-hidden": "true" }), testing ? " 正在測試連線…" : " 儲存中…");
    try {
      let probe: ProbeResult | null = null;
      if (testing) {
        probe = await api.testCamera(r.conn);
        if (!probe.ok) {
          showProbeFailure(r.conn, probe.error);
          return;
        }
      }
      const saved = existing ? await api.updateCamera(existing.id, config) : await api.createCamera(config);
      if (!ctx.isCurrent()) return;
      if (!probe?.ok) {
        toast(`已儲存「${saved.config.name}」`);
        navigate("/settings/cameras");
        return;
      }
      const view = successView(saved, probe, !existing);
      page.replaceWith(view);
      // 送出按鈕已經不在畫面上，焦點移到結果標題，螢幕閱讀器會念出「已加入」
      const title = view.querySelector<HTMLElement>("h1");
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
  const page = welcome
    ? h(
        "main",
        { class: "onboard" },
        h("div", { class: "onboard-brand" }, h("span", { class: "brand-mark" }, icon("camera", 17)), h("span", null, state.siteName)),
        h("header", { class: "onboard-head" }, h("h1", null, "加入第一台攝影機"), h("p", null, "填好後按「測試並儲存」，連線成功就會直接儲存，並馬上開始錄影。")),
        form,
      )
    : settingsSubpage(existing ? `編輯「${existing.config.name}」` : "新增攝影機", listHref, form);
  return page;
}

function successView(cam: CameraDto, probe: Extract<ProbeResult, { ok: true }>, created: boolean): HTMLElement {
  const c = cam.config;
  const recording = c.enabled && c.record.enabled;
  const view = h(
    "div",
    { class: "success-page" },
    h(
      "div",
      { class: "card success" },
      h(
        "div",
        { class: "success-shot" },
        probe.snapshotJpegBase64
          ? h("img", { alt: `${c.name} 的畫面`, src: `data:image/jpeg;base64,${probe.snapshotJpegBase64}`, width: "640", height: "360" })
          : h("span", { class: "cam-ph" }, icon("camera", 28)),
      ),
      h(
        "div",
        { class: "success-body" },
        h("h1", null, created ? `已加入「${c.name}」` : `已儲存「${c.name}」`),
        h("p", { class: "success-lead" }, icon("check-circle", 18), recording ? "已開始錄影" : "連線成功"),
        h(
          "details",
          { class: "spec-details" },
          h("summary", null, "詳細資訊"),
          h(
            "dl",
            { class: "spec" },
            h("dt", null, "高畫質"),
            h("dd", null, streamLine(probe.main)),
            h("dt", null, "低畫質"),
            h("dd", null, probe.sub ? streamLine(probe.sub) : "沒有，預覽會改用高畫質縮小"),
          ),
        ),
        h(
          "div",
          { class: "success-actions" },
          h("a", { class: "btn primary", href: created ? "#/cameras" : "#/settings/cameras" }, "完成"),
          created ? h("a", { class: "text-link", href: "#/settings/cameras/new" }, "再加一台") : null,
        ),
      ),
    ),
  );
  view.classList.add("page-enter");
  return view;
}
