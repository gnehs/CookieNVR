import { useId, useState, useSyncExternalStore } from "react";
import { ACCENTS, getAccent, getMode, setAccent, setMode, systemPrefersDark, type Accent, type ColorMode } from "../../theme.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Panel, PanelSection } from "../../ui/Panel.tsx";

const MODES: [ColorMode, string][] = [
  ["light", "淺色"],
  ["dark", "深色"],
  ["system", "跟隨系統"],
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

export function Appearance() {
  const modeName = useId();
  const accentName = useId();
  const [mode, setModeState] = useState(getMode);
  const [accent, setAccentState] = useState<Accent>(getAccent);
  const dark = useSyncExternalStore(subscribeSystem, () => systemPrefersDark.matches);
  return (
    <Panel title="外觀" actions={<span className="hint">只套用在這個瀏覽器</span>}>
      <PanelSection title="色彩模式" desc="選擇淺色或深色，或跟著系統自動切換。">
        <div className="tiles modes" role="radiogroup" aria-label="色彩模式">
          {MODES.map(([value, label]) => (
            <label className="tile" key={value}>
              <input
                type="radio"
                name={modeName}
                value={value}
                checked={value === mode}
                aria-label={label}
                onChange={(e) => {
                  if (!e.currentTarget.checked) return;
                  setMode(value);
                  setModeState(value);
                }}
              />
              <ModeThumb mode={value} />
              <span className="tile-label">
                {label}
                {value === "system" ? <small>目前為{dark ? "深色" : "淺色"}</small> : null}
              </span>
            </label>
          ))}
        </div>
      </PanelSection>
      <PanelSection title="主色" desc="用在按鈕、選取狀態與導覽列。">
        <div className="swatches" role="radiogroup" aria-label="主色">
          {ACCENTS.map((a) => (
            <label className="swatch" data-accent={a.id} key={a.id}>
              <input
                type="radio"
                name={accentName}
                value={a.id}
                checked={a.id === accent}
                aria-label={a.label}
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
                {a.label}
              </span>
            </label>
          ))}
        </div>
      </PanelSection>
    </Panel>
  );
}
