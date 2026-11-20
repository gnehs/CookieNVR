import { useEffect, useRef, useState, type InputHTMLAttributes, type RefObject } from "react";
import type { CameraDto } from "../../../src/api-types.ts";
import { maskedField } from "../../camera-form-logic.ts";
import { CopyButton } from "../../ui/Button.tsx";
import { Segmented, Switch, Tiles } from "../../ui/controls.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { SettingRow, type RowA11y } from "../../ui/SettingRow.tsx";
import { Disclosure } from "./bits.tsx";
import { connAdvancedOpen, connAdvancedSummary, invalidFields, type Draft, type FieldKey, type FlagKey, type FormError, type TextKey } from "./form-model.ts";

/** 新增頁與編輯頁的對話框共用的欄位：draft 是目前的值，set 改值，error 決定哪些欄位標紅 */
export interface FieldKit {
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  error: FormError | null;
}

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

function controls({ draft, set, error }: FieldKit) {
  const invalid = new Set(invalidFields(error));
  const fieldError = (key: FieldKey) => (error?.field?.key === key ? error.field.message : undefined);
  const inputProps = (key: FieldKey, a: RowA11y) => ({ ...a, name: key, "aria-invalid": invalid.has(key) || undefined });
  return {
    fieldError,
    inputProps,
    text: (key: TextKey, attrs: InputHTMLAttributes<HTMLInputElement> = {}) => (a: RowA11y) => (
      <input type="text" autoComplete="off" spellCheck={false} autoCapitalize="off" {...attrs} {...inputProps(key, a)} value={draft[key]} onChange={(e) => set({ [key]: e.currentTarget.value })} />
    ),
    secret: (key: TextKey) => (a: RowA11y) => <input type="password" autoComplete="new-password" {...inputProps(key, a)} value={draft[key]} onChange={(e) => set({ [key]: e.currentTarget.value })} />,
    url: (key: "mainUrl" | "subUrl", placeholder: string) => (a: RowA11y) => <UrlInput {...inputProps(key, a)} placeholder={placeholder} value={draft[key]} onValue={(v) => set({ [key]: v })} />,
    flag: (key: FlagKey, title: string, desc?: string) => <SettingRow title={title} desc={desc} toggle control={(a) => <Switch {...a} name={key} checked={draft[key]} onChange={(v) => set({ [key]: v })} />} />,
  };
}

/** 名稱；編輯時多一個「啟用」開關 */
export function BasicFields({ kit, existing, nameRef }: { kit: FieldKit; existing: boolean; nameRef?: RefObject<HTMLInputElement | null> }) {
  const c = controls(kit);
  return (
    <>
      <SettingRow
        title="名稱"
        desc="會顯示在首頁與錄影頁。"
        wide
        error={c.fieldError("name")}
        control={(a) => <input ref={nameRef} type="text" autoComplete="off" spellCheck={false} autoCapitalize="off" placeholder="例如：客廳、前門" maxLength={60} {...c.inputProps("name", a)} value={kit.draft.name} onChange={(e) => kit.set({ name: e.currentTarget.value })} />}
      />
      {existing ? c.flag("enabled", "啟用這台攝影機", "停用後不看畫面也不錄影，但保留設定。") : null}
    </>
  );
}

/** 攝影機類型（Tapo／其他）、連線欄位與進階；existing 有值時多一列「給其他 App 的串流網址」 */
export function ConnFields({ kit, existing }: { kit: FieldKit; existing: CameraDto | null }) {
  const c = controls(kit);
  const { draft, set } = kit;
  const rtsp = draft.type === "rtsp";
  return (
    <>
      <div className="set-block">
        <span className="sr-only">攝影機類型</span>
        <Tiles
          label="攝影機類型"
          options={[
            { value: "tapo", label: "Tapo", desc: "只要填 IP 與相機帳號", icon: "tapo" },
            { value: "rtsp", label: "其他攝影機", desc: "任何支援 RTSP 的攝影機", icon: "link" },
          ]}
          value={draft.type}
          onChange={(type) => set({ type })}
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
        <SettingRow title="相機 IP 位址" desc="建議在路由器把這個位址固定下來。" wide error={c.fieldError("tapoHost")} control={c.text("tapoHost", { placeholder: "例如 192.168.1.50", inputMode: "url" })} />
        <SettingRow title="相機帳號" wide error={c.fieldError("tapoUser")} control={c.text("tapoUser")} />
        <SettingRow title="相機密碼" wide error={c.fieldError("tapoPass")} control={c.secret("tapoPass")} />
      </div>
      <div className="set-rows" hidden={!rtsp}>
        <SettingRow title="串流網址" desc="以 rtsp:// 開頭，通常寫在相機的說明書或 App 裡。帳號密碼可以直接寫在網址中。" wide error={c.fieldError("mainUrl")} control={c.url("mainUrl", "rtsp://帳號:密碼@192.168.1.60:554/stream1")} />
        <SettingRow title="低畫質串流網址" desc="選填。有的話，首頁預覽與動作偵測會更省資源。" wide error={c.fieldError("subUrl")} control={c.url("subUrl", "rtsp://…/stream2")} />
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
          {c.flag("onvifOn", "使用 ONVIF", "可以控制鏡頭轉向，並接收相機自己偵測到的事件。")}
          <div className="set-rows" hidden={!draft.onvifOn}>
            <SettingRow title="ONVIF 主機" wide error={c.fieldError("ovHost")} control={c.text("ovHost", { placeholder: "192.168.1.60" })} />
            <SettingRow title="連接埠" error={c.fieldError("ovPort")} control={c.text("ovPort", { inputMode: "numeric" })} />
            <SettingRow title="ONVIF 帳號" wide control={c.text("ovUser")} />
            <SettingRow title="ONVIF 密碼" wide control={c.secret("ovPass")} />
          </div>
        </div>
        {c.flag("recDirect", "錄影直接連到相機", "影像服務出問題時錄影不受影響，但會多佔用相機一條連線。")}
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
    </>
  );
}

export function RecFields({ kit }: { kit: FieldKit }) {
  const c = controls(kit);
  return (
    <>
      {c.flag("recEnabled", "全天候錄影")}
      {c.flag("recAudio", "錄下聲音")}
    </>
  );
}

/** 錯誤掛在欄位旁：展開它所在的收合區塊，捲過去並聚焦 */
export function useFocusError(root: RefObject<HTMLElement | null>, error: FormError | null) {
  useEffect(() => {
    if (!error?.field) return;
    const input = root.current?.querySelector<HTMLInputElement>(`[name="${error.field.key}"]`);
    if (!input) return;
    const closed: HTMLDetailsElement[] = [];
    for (let d = input.closest("details"); d; d = d.parentElement?.closest("details") ?? null) if (!d.open) closed.push(d);
    for (const d of closed) d.open = true;
    const go = () => {
      input.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
      input.focus({ preventScroll: true });
    };
    // 剛展開的區塊在展開動畫結束前內容還不能聚焦
    if (closed.length && !reducedMotion()) {
      const t = setTimeout(go, 300);
      return () => clearTimeout(t);
    }
    go();
  }, [error]);
}
