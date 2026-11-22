import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState, type InputHTMLAttributes, type RefObject } from "react";
import type { CameraDto } from "../../../src/api-types.ts";
import { maskedField } from "../../camera-form-logic.ts";
import { CopyButton } from "../../ui/Button.tsx";
import { Segmented, Switch, Tiles } from "../../ui/controls.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { SettingRow, SettingsDisclosure, type RowA11y } from "../../ui/SettingRow.tsx";
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
  const { t } = useLingui();
  const c = controls(kit);
  return (
    <>
      <SettingRow
        title={t`Name`}
        desc={t`Shown on the home page and on the camera's own page.`}
        wide
        error={c.fieldError("name")}
        control={(a) => <input ref={nameRef} type="text" autoComplete="off" spellCheck={false} autoCapitalize="off" placeholder={t`For example: Living room, Front door`} maxLength={60} {...c.inputProps("name", a)} value={kit.draft.name} onChange={(e) => kit.set({ name: e.currentTarget.value })} />}
      />
      {existing ? c.flag("enabled", t`Enable this camera`, t`When disabled, it neither shows video nor records, but its settings are kept.`) : null}
    </>
  );
}

/** 攝影機類型（Tapo／其他）、連線欄位與進階；existing 有值時多一列「給其他 App 的串流網址」 */
export function ConnFields({ kit, existing }: { kit: FieldKit; existing: CameraDto | null }) {
  const { t } = useLingui();
  const c = controls(kit);
  const { draft, set } = kit;
  const rtsp = draft.type === "rtsp";
  return (
    <>
      <div className="set-block">
        <span className="sr-only">{t`Camera type`}</span>
        <Tiles
          label={t`Camera type`}
          options={[
            { value: "tapo", label: "Tapo", desc: t`Just enter the IP and camera account`, icon: "tapo" },
            { value: "rtsp", label: t`Other camera`, desc: t`Any camera that supports RTSP`, icon: "link" },
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
              <Trans>
                Create the username and password in the Tapo app under "Advanced settings → Camera account". It is <b>not</b> your TP-Link cloud account.
              </Trans>
            </span>
          </p>
        </div>
        {/* 不用 inputMode="decimal"：iPhone 的數字鍵盤打不出主機名稱 */}
        <SettingRow title={t`Camera IP address`} desc={t`We recommend reserving this address in your router.`} wide error={c.fieldError("tapoHost")} control={c.text("tapoHost", { placeholder: t`For example 192.168.1.50`, inputMode: "url" })} />
        <SettingRow title={t`Camera username`} wide error={c.fieldError("tapoUser")} control={c.text("tapoUser")} />
        <SettingRow title={t`Camera password`} wide error={c.fieldError("tapoPass")} control={c.secret("tapoPass")} />
      </div>
      <div className="set-rows" hidden={!rtsp}>
        <SettingRow title={t`Stream URL`} desc={t`Starts with rtsp://, usually found in the camera's manual or app. You can put the username and password in the URL.`} wide error={c.fieldError("mainUrl")} control={c.url("mainUrl", t`rtsp://username:password@192.168.1.60:554/stream1`)} />
        <SettingRow title={t`Low-quality stream URL`} desc={t`Optional. If provided, home page previews and motion detection use fewer resources.`} wide error={c.fieldError("subUrl")} control={c.url("subUrl", "rtsp://…/stream2")} />
      </div>
      <SettingsDisclosure title={t`Advanced`} summary={connAdvancedSummary(draft)} defaultOpen={connAdvancedOpen(draft)}>
        <div className="set-rows" hidden={!rtsp}>
          <SettingRow
            title={t`Transport`}
            desc={t`TCP is stable and doesn't drop frames, so it's recommended. UDP has lower latency but can show glitches on an unstable network.`}
            control={
              <Segmented
                label={t`Transport`}
                options={[
                  { value: "tcp", label: "TCP" },
                  { value: "udp", label: "UDP" },
                ]}
                value={draft.transport}
                onChange={(transport) => set({ transport })}
              />
            }
          />
          {c.flag("onvifOn", t`Use ONVIF`, t`Lets you steer the camera and receive events the camera detects itself.`)}
          <div className="set-rows" hidden={!draft.onvifOn}>
            <SettingRow title={t`ONVIF host`} wide error={c.fieldError("ovHost")} control={c.text("ovHost", { placeholder: "192.168.1.60" })} />
            <SettingRow title={t`Port`} error={c.fieldError("ovPort")} control={c.text("ovPort", { inputMode: "numeric" })} />
            <SettingRow title={t`ONVIF username`} wide control={c.text("ovUser")} />
            <SettingRow title={t`ONVIF password`} wide control={c.secret("ovPass")} />
          </div>
        </div>
        {c.flag("recDirect", t`Record straight from the camera`, t`Recording keeps working if the video service has problems, but it uses one more connection on the camera.`)}
        {existing ? (
          <SettingRow
            title={t`Stream URL for other apps`}
            wide
            desc={t`After turning on "Let other apps read camera video" under Settings → General, VLC or Home Assistant can use this URL to watch this camera.`}
            control={
              <div className="form-actions">
                <CopyButton label={t`Copy stream URL`} className="small" done={t`Stream URL copied`} getText={() => existing.rtsp.main} />
                {existing.rtsp.sub ? <CopyButton label={t`Copy low-quality URL`} className="small" done={t`Low-quality stream URL copied`} getText={() => existing.rtsp.sub!} /> : null}
              </div>
            }
          />
        ) : null}
      </SettingsDisclosure>
    </>
  );
}

export function RecFields({ kit }: { kit: FieldKit }) {
  const { t } = useLingui();
  const c = controls(kit);
  return (
    <>
      {c.flag("recEnabled", t`Record 24/7`)}
      {c.flag("recAudio", t`Record sound`)}
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
