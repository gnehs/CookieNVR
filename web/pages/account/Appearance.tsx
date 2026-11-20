import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useId, useState, useSyncExternalStore } from "react";
import { getLocalePref, LOCALES, setLocalePref, systemLocale, type LocalePref } from "../../i18n.ts";
import { ACCENTS, getAccent, getMode, setAccent, setMode, systemPrefersDark, type Accent, type ColorMode } from "../../theme.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Panel, PanelSection } from "../../ui/Panel.tsx";
import { Select } from "../../ui/Select.tsx";

const MODES: [ColorMode, MessageDescriptor][] = [
  ["light", msg`Light`],
  ["dark", msg`Dark`],
  ["system", msg`Match system`],
];

const subscribeSystem = (fn: () => void) => {
  systemPrefersDark.addEventListener("change", fn);
  return () => systemPrefersDark.removeEventListener("change", fn);
};

function ModeThumb({ mode }: { mode: ColorMode }) {
  const pane = (dark: boolean) => (
    <span className={`thumb-inner${dark ? " dark" : ""}`}>
      <i />
      <i />
    </span>
  );
  return (
    <span className="thumb" aria-hidden="true">
      {mode === "system" ? (
        <span className="thumb-split">
          {pane(false)}
          {pane(true)}
        </span>
      ) : (
        pane(mode === "dark")
      )}
    </span>
  );
}

function LanguageSelect() {
  const { t } = useLingui();
  const [pref, setPref] = useState<LocalePref>(getLocalePref);
  const system = LOCALES.find((l) => l.id === systemLocale())!;
  return (
    <Select<LocalePref>
      label={t`Language`}
      icon="globe"
      value={pref}
      entries={[
        { value: "system", label: t`Match browser`, desc: system.label },
        "separator",
        ...LOCALES.map((l) => ({ value: l.id, label: l.label })),
      ]}
      onChange={(v) => {
        setPref(v);
        void setLocalePref(v);
      }}
    />
  );
}

export function Appearance() {
  const { t, i18n } = useLingui();
  const modeName = useId();
  const accentName = useId();
  const [mode, setModeState] = useState(getMode);
  const [accent, setAccentState] = useState<Accent>(getAccent);
  const dark = useSyncExternalStore(subscribeSystem, () => systemPrefersDark.matches);
  return (
    <Panel title={t`Appearance`} actions={<span className="hint">{t`Applies to this browser only`}</span>}>
      <PanelSection title={t`Color mode`} desc={t`Choose light or dark, or follow your system automatically.`}>
        <div className="tiles modes" role="radiogroup" aria-label={t`Color mode`}>
          {MODES.map(([value, label]) => (
            <label className="tile" key={value}>
              <input
                type="radio"
                name={modeName}
                value={value}
                checked={value === mode}
                aria-label={i18n._(label)}
                onChange={(e) => {
                  if (!e.currentTarget.checked) return;
                  setMode(value);
                  setModeState(value);
                }}
              />
              <ModeThumb mode={value} />
              <span className="tile-label">
                {i18n._(label)}
                {value === "system" ? <small>{dark ? t`Currently dark` : t`Currently light`}</small> : null}
              </span>
            </label>
          ))}
        </div>
      </PanelSection>
      <PanelSection title={t`Accent color`} desc={t`Used for buttons, selections, and navigation.`}>
        <div className="swatches" role="radiogroup" aria-label={t`Accent color`}>
          {ACCENTS.map((a) => (
            <label className="swatch" data-accent={a.id} key={a.id}>
              <input
                type="radio"
                name={accentName}
                value={a.id}
                checked={a.id === accent}
                aria-label={i18n._(a.label)}
                onChange={(e) => {
                  if (!e.currentTarget.checked) return;
                  setAccent(a.id);
                  setAccentState(a.id);
                }}
              />
              <span className="swatch-face">
                <span className="swatch-dot" aria-hidden="true">
                  <Icon name="check" size={15} />
                </span>
                {i18n._(a.label)}
              </span>
            </label>
          ))}
        </div>
      </PanelSection>
      <PanelSection title={t`Language`} desc={t`The language of the interface.`}>
        <LanguageSelect />
      </PanelSection>
    </Panel>
  );
}
