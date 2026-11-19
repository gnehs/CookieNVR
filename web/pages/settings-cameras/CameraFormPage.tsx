import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent, type InputHTMLAttributes } from "react";
import type { CameraDto, ProbeResult } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { maskedField } from "../../camera-form-logic.ts";
import { camerasQuery, ptzQuery, settingsQuery, systemQuery } from "../../data/queries.ts";
import { infoQuery } from "../../data/session.ts";
import { objectSummary, modeOf } from "../../detect/object-model.ts";
import { errMsg } from "../../format.ts";
import { ButtonLink, CopyButton } from "../../ui/Button.tsx";
import { Segmented, Switch, Tiles } from "../../ui/controls.tsx";
import { confirmDialog } from "../../ui/Dialog.tsx";
import { FormCard } from "../../ui/FormCard.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { BrandMark } from "../../ui/Panel.tsx";
import { SettingRow, type RowA11y } from "../../ui/SettingRow.tsx";
import { ErrorBox, PageError, Spinner } from "../../ui/states.tsx";
import { toast } from "../../ui/toast.tsx";
import { SettingsSubpage } from "../settings/SettingsLayout.tsx";
import { Disclosure, useDetailsOpen } from "./bits.tsx";
import { putCamera } from "./CamerasListPage.tsx";
import { DetectSection } from "./DetectSection.tsx";
import {
  basicSummary,
  connAdvancedOpen,
  connAdvancedSummary,
  connKey,
  connSummary,
  DEFAULT_PTZ,
  detectSummary,
  dirtyCards,
  draftOf,
  errorCard,
  invalidFields,
  probeFailure,
  recSummary,
  streamLine,
  validate,
  type CardKey,
  type Draft,
  type FieldKey,
  type FlagKey,
  type FormError,
  type TextKey,
} from "./form-model.ts";
import { HomekitSection, homekitQuery, homekitSummary } from "./HomekitSection.tsx";
import { PtzPrefsField, ptzSummary, PtzSupportNote } from "./PtzPrefs.tsx";
import { sensorsOf, StatesSection, statesSummary } from "./StatesSection.tsx";
import { statesQuery } from "../../states/queries.ts";
import { useDeleteCamera } from "./useDeleteCamera.tsx";

export type CameraFormMode = "welcome" | "new" | "edit";

type Probed = Extract<ProbeResult, { ok: true }>;

/** 送出的進度：測試連線、儲存，成功且有測試結果時換成結果頁 */
type Phase = { kind: "editing" } | { kind: "testing" } | { kind: "saving" } | { kind: "done"; cam: CameraDto; probe: Probed; created: boolean };

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 串流網址：沒聚焦時遮住網址裡的密碼；送出用的是真正輸入的值，不受畫面遮蔽影響 */
function UrlInput({ value, onValue, ...rest }: { value: string; onValue: (v: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const masked = useRef(maskedField(value));
  const [, setFocused] = useState(false);
  return (
    <input
      {...rest}
      type="text"
      autoComplete="off"
      spellCheck={false}
      autoCapitalize="off"
      inputMode="url"
      value={masked.current.display()}
      onFocus={() => {
        masked.current.focus();
        setFocused(true);
      }}
      onBlur={() => {
        masked.current.blur();
        setFocused(false);
      }}
      onChange={(e) => {
        masked.current.input(e.currentTarget.value);
        onValue(masked.current.value());
      }}
    />
  );
}

function SuccessView({ cam, probe, created, onAgain }: { cam: CameraDto; probe: Probed; created: boolean; onAgain: () => void }) {
  const c = cam.config;
  const title = useRef<HTMLHeadingElement>(null);
  // 送出按鈕已經不在畫面上，焦點移到結果標題，螢幕閱讀器會念出「已加入」
  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, []);
  return (
    <div className="success-page page-enter">
      <div className="card success">
        <div className="success-shot">
          {probe.snapshotJpegBase64 ? (
            <img alt={`${c.name} 的畫面`} src={`data:image/jpeg;base64,${probe.snapshotJpegBase64}`} width={640} height={360} />
          ) : (
            <span className="cam-ph">
              <Icon name="camera" size={28} />
            </span>
          )}
        </div>
        <div className="success-body">
          <h1 ref={title} tabIndex={-1}>
            {created ? `已加入「${c.name}」` : `已儲存「${c.name}」`}
          </h1>
          <p className="success-lead">
            <Icon name="check-circle" size={18} />
            {c.enabled && c.record.enabled ? "已開始錄影" : "連線成功"}
          </p>
          <PtzSupportNote onvif={probe.onvif} />
          <details className="spec-details">
            <summary>詳細資訊</summary>
            <dl className="spec">
              <dt>高畫質</dt>
              <dd>{streamLine(probe.main)}</dd>
              <dt>低畫質</dt>
              <dd>{probe.sub ? streamLine(probe.sub) : "沒有，預覽會改用高畫質縮小"}</dd>
            </dl>
          </details>
          <div className="success-actions">
            <ButtonLink to={created ? "/cameras" : "/settings/cameras"} variant="primary">
              完成
            </ButtonLink>
            {created ? (
              <Link className="text-link" to="/settings/cameras/new" onClick={onAgain}>
                再加一台
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function CameraForm({ existing, mode, onAgain }: { existing: CameraDto | null; mode: CameraFormMode; onAgain: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const welcome = mode === "welcome";
  const listHref = welcome ? "/cameras" : "/settings/cameras";
  const siteName = useQuery(infoQuery).data?.siteName ?? "CookieNVR";

  const [saved] = useState(() => draftOf(existing?.config ?? null));
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<FormError | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });

  const objectsOn = useQuery({ ...settingsQuery, enabled: !!existing }).data?.objects.enabled ?? false;
  const homekit = useQuery({ ...homekitQuery(existing?.id ?? ""), enabled: !!existing }).data;
  const sensors = useQuery({ ...statesQuery, enabled: !!existing, select: (list) => sensorsOf(list, existing?.id ?? "") }).data;
  const ptzSupported = useQuery({ ...ptzQuery(existing?.id ?? ""), enabled: !!existing }).data?.supported === true;
  const del = useDeleteCamera();

  const form = useRef<HTMLFormElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const detectProbe = useRef<HTMLSpanElement>(null);
  const detectOpen = useDetailsOpen(detectProbe);

  const dirty: Set<CardKey> = existing ? dirtyCards(draft, saved) : new Set();
  const isDirty = !existing || dirty.size > 0;
  const needsTest = !existing || connKey(draft) !== connKey(saved);
  const busy = phase.kind === "testing" || phase.kind === "saving";
  const badCard = errorCard(error);
  const invalid = new Set(invalidFields(error));

  // 離開前提醒：有改過、而且還沒存好
  const leaving = useRef(false);
  const unsaved = phase.kind !== "done" && JSON.stringify(draft) !== JSON.stringify(saved);
  const unsavedRef = useRef(unsaved);
  unsavedRef.current = unsaved;
  useBlocker({
    shouldBlockFn: async () => {
      if (leaving.current || !unsavedRef.current) return false;
      return !(await confirmDialog("要離開這一頁嗎？", "還沒儲存的變更會不見。", { confirmLabel: "離開", danger: true }));
    },
    enableBeforeUnload: () => !leaving.current && unsavedRef.current,
  });

  useEffect(() => {
    if (!existing && matchMedia("(pointer: fine)").matches) nameInput.current?.focus();
  }, []);

  // 錯誤掛在欄位旁：展開它所在的卡片與進階區塊，捲過去並聚焦
  useEffect(() => {
    if (!error?.field) return;
    const input = form.current?.querySelector<HTMLInputElement>(`[name="${error.field.key}"]`);
    if (!input) return;
    const closed: HTMLDetailsElement[] = [];
    for (let d = input.closest("details"); d; d = d.parentElement?.closest("details") ?? null) if (!d.open) closed.push(d);
    for (const d of closed) d.open = true;
    const go = () => {
      input.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
      input.focus({ preventScroll: true });
    };
    // 剛展開的卡片在展開動畫結束前內容還不能聚焦
    if (closed.length && !reducedMotion()) {
      const t = setTimeout(go, 300);
      return () => clearTimeout(t);
    }
    go();
  }, [error]);

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    if (error && Object.keys(patch).some((k) => invalid.has(k as FieldKey))) setError(null);
  };
  const fieldError = (key: FieldKey) => (error?.field?.key === key ? error.field.message : undefined);
  const inputProps = (key: FieldKey, a: RowA11y) => ({ ...a, name: key, "aria-invalid": invalid.has(key) || undefined });
  const text = (key: TextKey, attrs: InputHTMLAttributes<HTMLInputElement> = {}) => (a: RowA11y) => (
    <input type="text" autoComplete="off" spellCheck={false} autoCapitalize="off" {...attrs} {...inputProps(key, a)} value={draft[key]} onChange={(e) => set({ [key]: e.currentTarget.value })} />
  );
  const secret = (key: TextKey) => (a: RowA11y) => <input type="password" autoComplete="new-password" {...inputProps(key, a)} value={draft[key]} onChange={(e) => set({ [key]: e.currentTarget.value })} />;
  const url = (key: "mainUrl" | "subUrl", placeholder: string) => (a: RowA11y) => <UrlInput {...inputProps(key, a)} placeholder={placeholder} value={draft[key]} onValue={(v) => set({ [key]: v })} />;
  const flag = (key: FlagKey, title: string, desc?: string) => (
    <SettingRow title={title} desc={desc} toggle control={(a) => <Switch {...a} name={key} checked={draft[key]} onChange={(v) => set({ [key]: v })} />} />
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const r = validate(draft, existing?.config ?? null, homekit ? { enabled: homekit.enabled } : existing?.config.homekit);
    if ("error" in r) return setError(r.error);
    const testing = needsTest;
    setPhase({ kind: testing ? "testing" : "saving" });
    try {
      let probe: ProbeResult | null = null;
      if (testing) {
        probe = await api.testCamera(r.conn);
        if (!probe.ok) return setError(probeFailure(r.conn, probe.error, probe.detail));
      }
      const cam = existing ? await api.updateCamera(existing.id, r.config) : await api.createCamera(r.config);
      putCamera(qc, cam);
      void qc.invalidateQueries({ queryKey: systemQuery.queryKey });
      if (!probe) {
        toast(`已儲存「${cam.config.name}」`);
        leaving.current = true;
        void navigate({ to: "/settings/cameras" });
        return;
      }
      setPhase({ kind: "done", cam, probe, created: !existing });
    } catch (err) {
      setError({ summary: errMsg(err) });
    } finally {
      setPhase((p) => (p.kind === "done" ? p : { kind: "editing" }));
    }
  };

  const removeCamera = async () => {
    if (!existing) return;
    leaving.current = true;
    if (await del.remove(existing)) void navigate({ to: "/settings/cameras" });
    else leaving.current = false;
  };

  if (phase.kind === "done") return <SuccessView cam={phase.cam} probe={phase.probe} created={phase.created} onAgain={onAgain} />;

  const card = (key: CardKey) => ({ dirty: dirty.has(key), error: badCard === key });
  const onvif = draft.type === "tapo" || draft.onvifOn;
  const detect = draft.detect;
  const objectsText = existing && objectsOn && detect?.enabled ? objectSummary(modeOf(detect.objectMode), detect.labels) : null;
  const rtsp = draft.type === "rtsp";

  const body = (
    <form ref={form} className="cam-form" noValidate onSubmit={submit}>
      <div className="fcards">
        {/* 編輯時全部收合，摘要一眼看完；新增時只有基本與連線，直接展開 */}
        <FormCard title="基本" icon="edit" defaultOpen={!existing} summary={basicSummary(draft, !!existing)} {...card("basic")}>
          <SettingRow title="名稱" desc="會顯示在首頁與錄影頁。" wide error={fieldError("name")} control={(a) => <input ref={nameInput} type="text" autoComplete="off" spellCheck={false} autoCapitalize="off" placeholder="例如：客廳、前門" maxLength={60} {...inputProps("name", a)} value={draft.name} onChange={(e) => set({ name: e.currentTarget.value })} />} />
          {existing ? flag("enabled", "啟用這台攝影機", "停用後不看畫面也不錄影，但保留設定。") : null}
        </FormCard>
        <FormCard title="連線" icon="link" defaultOpen={!existing} summary={connSummary(draft)} {...card("conn")}>
          <div className="set-block">
            <span className="sr-only">攝影機類型</span>
            <Tiles
              label="攝影機類型"
              options={[
                { value: "tapo", label: "Tapo", desc: "只要填 IP 與相機帳號", icon: "tapo" },
                { value: "rtsp", label: "其他攝影機", desc: "任何支援 RTSP 的攝影機", icon: "link" },
              ]}
              value={draft.type}
              onChange={(type) => {
                setDraft((d) => ({ ...d, type }));
                setError(null);
              }}
            />
          </div>
          <div className="set-rows" hidden={rtsp}>
            <div className="set-block">
              <p className="callout">
                <Icon name="info" />
                <span>
                  帳號密碼請在 Tapo App 的「進階設定 → 相機帳戶」建立，<b>不是</b> TP-Link 雲端帳號。
                </span>
              </p>
            </div>
            {/* 不用 inputMode="decimal"：iPhone 的數字鍵盤打不出主機名稱 */}
            <SettingRow title="相機 IP 位址" desc="建議在路由器把這個位址固定下來。" wide error={fieldError("tapoHost")} control={text("tapoHost", { placeholder: "例如 192.168.1.50", inputMode: "url" })} />
            <SettingRow title="相機帳號" wide error={fieldError("tapoUser")} control={text("tapoUser")} />
            <SettingRow title="相機密碼" wide error={fieldError("tapoPass")} control={secret("tapoPass")} />
          </div>
          <div className="set-rows" hidden={!rtsp}>
            <SettingRow title="串流網址" desc="以 rtsp:// 開頭，通常寫在相機的說明書或 App 裡。帳號密碼可以直接寫在網址中。" wide error={fieldError("mainUrl")} control={url("mainUrl", "rtsp://帳號:密碼@192.168.1.60:554/stream1")} />
            <SettingRow title="低畫質串流網址" desc="選填。有的話，首頁預覽與動作偵測會更省資源。" wide error={fieldError("subUrl")} control={url("subUrl", "rtsp://…/stream2")} />
          </div>
          <Disclosure title="進階" summary={connAdvancedSummary(draft)} defaultOpen={connAdvancedOpen(draft)}>
            <div className="set-rows" hidden={!rtsp}>
              <SettingRow
                title="傳輸方式"
                desc="TCP 穩定不掉畫面，建議使用；UDP 延遲較低，網路不穩時容易花屏。"
                control={
                  <Segmented
                    label="傳輸方式"
                    options={[
                      { value: "tcp", label: "TCP" },
                      { value: "udp", label: "UDP" },
                    ]}
                    value={draft.transport}
                    onChange={(transport) => set({ transport })}
                  />
                }
              />
              {flag("onvifOn", "使用 ONVIF", "可以控制鏡頭轉向，並接收相機自己偵測到的事件。")}
              <div className="set-rows" hidden={!draft.onvifOn}>
                <SettingRow title="ONVIF 主機" wide error={fieldError("ovHost")} control={text("ovHost", { placeholder: "192.168.1.60" })} />
                <SettingRow title="連接埠" error={fieldError("ovPort")} control={text("ovPort", { inputMode: "numeric" })} />
                <SettingRow title="ONVIF 帳號" wide control={text("ovUser")} />
                <SettingRow title="ONVIF 密碼" wide control={secret("ovPass")} />
              </div>
            </div>
            {flag("recDirect", "錄影直接連到相機", "影像服務出問題時錄影不受影響，但會多佔用相機一條連線。")}
            {existing ? (
              <SettingRow
                title="給其他 App 的串流網址"
                wide
                desc="在「設定 → 一般」開啟「讓其他 App 讀取攝影機畫面」後，VLC 或 Home Assistant 可以用這個網址看這台攝影機。"
                control={
                  <div className="form-actions">
                    <CopyButton label="複製串流網址" className="small" done="已複製串流網址" getText={() => existing.rtsp.main} />
                    {existing.rtsp.sub ? <CopyButton label="複製低畫質網址" className="small" done="已複製低畫質串流網址" getText={() => existing.rtsp.sub!} /> : null}
                  </div>
                }
              />
            ) : null}
          </Disclosure>
        </FormCard>
        <FormCard title="錄影" icon="rec" summary={recSummary(draft)} {...card("rec")}>
          {flag("recEnabled", "全天候錄影")}
          {flag("recAudio", "錄下聲音")}
        </FormCard>
        {existing && detect ? (
          <FormCard title="偵測" icon="activity" className="fcard-detect" summary={detectSummary(detect, objectsText)} {...card("detect")}>
            <span ref={detectProbe} hidden />
            <DetectSection camera={existing} value={detect} saved={saved.detect!} onChange={(patch) => set({ detect: { ...detect, ...patch } })} onvif={onvif} active={detectOpen} objects={objectsOn} />
          </FormCard>
        ) : null}
        {existing ? (
          <FormCard title="狀態辨識" icon="toggle" className="fcard-states" summary={statesSummary(sensors)}>
            <StatesSection camera={existing} />
          </FormCard>
        ) : null}
        {existing && ptzSupported ? (
          <FormCard title="鏡頭控制" icon="crosshair" summary={ptzSummary(draft.ptz ?? DEFAULT_PTZ)} {...card("ptz")}>
            <div className="set-block">
              <PtzPrefsField value={draft.ptz ?? DEFAULT_PTZ} onChange={(ptz) => set({ ptz })} />
            </div>
          </FormCard>
        ) : null}
        {existing ? (
          <FormCard title="Apple 家庭" icon="home" className="fcard-homekit" summary={homekitSummary(homekit)}>
            <HomekitSection camera={existing} />
          </FormCard>
        ) : null}
      </div>
      <div className="form-bar">
        <div className="foot-status">
          <p className="form-error" role="alert">
            {error?.summary}
          </p>
          <span className="copy-slot">{error?.copy ? <CopyButton label="複製錯誤內容" className="small ghost" done="已複製錯誤內容，可以貼給 AI 或技術人員" getText={() => error.copy!} /> : null}</span>
        </div>
        <Link className="btn" to={listHref}>
          {welcome ? "稍後再說" : "取消"}
        </Link>
        <button className="btn primary" type="submit" disabled={busy || !isDirty} aria-busy={busy || undefined}>
          {busy ? (
            <>
              <span className="spin" aria-hidden="true" />
              <span>{phase.kind === "testing" ? "正在測試連線…" : "儲存中…"}</span>
            </>
          ) : (
            <span>{needsTest ? "測試並儲存" : "儲存變更"}</span>
          )}
        </button>
      </div>
      {existing ? (
        <section className="danger-zone">
          <div className="danger-text">
            <b>刪除這台攝影機</b>
            <p>停止錄影並移除設定；可以選擇是否一起刪除已錄的影片。</p>
          </div>
          <button className="btn danger" type="button" onClick={() => void removeCamera()}>
            <Icon name="trash" size={16} />
            刪除攝影機
          </button>
        </section>
      ) : null}
      {del.dialog}
    </form>
  );

  if (welcome) {
    return (
      <main className="onboard">
        <div className="onboard-brand">
          <BrandMark />
          <span>{siteName}</span>
        </div>
        <header className="onboard-head">
          <h1>加入第一台攝影機</h1>
          <p>填好後按「測試並儲存」，連線成功就會直接儲存，並馬上開始錄影。</p>
        </header>
        {body}
      </main>
    );
  }
  return (
    <SettingsSubpage title={existing ? `編輯「${existing.config.name}」` : "新增攝影機"} back={listHref}>
      {body}
    </SettingsSubpage>
  );
}

/**
 * 新增（含首次使用的 /welcome）與編輯攝影機。編輯時從攝影機快取找這台；表單內容只在打開時取一次，
 * 之後 SSE 推來的狀態更新不會蓋掉正在編輯的值。
 */
export function CameraFormPage({ id, mode }: { id: string | null; mode: CameraFormMode }) {
  const cams = useQuery({ ...camerasQuery, enabled: id !== null });
  const [round, setRound] = useState(0);
  // 刪除後快取裡已經沒有這台，但還沒換頁；別閃一下「找不到」
  const last = useRef<CameraDto | null>(null);
  if (id === null) return <CameraForm key={`new-${round}`} existing={null} mode={mode} onAgain={() => setRound((n) => n + 1)} />;
  if (cams.isPending) return <Spinner />;
  if (cams.isError) return <ErrorBox error={cams.error} onRetry={() => void cams.refetch()} />;
  const cam = cams.data.find((c) => c.id === id) ?? (last.current?.id === id ? last.current : null);
  if (!cam) return <ErrorBox error={new PageError("找不到這台攝影機", "它可能已經被刪除了。", { label: "回到攝影機列表", to: "/settings/cameras" })} />;
  last.current = cam;
  return <CameraForm key={id} existing={cam} mode="edit" onAgain={() => {}} />;
}
