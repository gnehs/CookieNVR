import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type { CameraDto } from "../../../src/api-types.ts";
import { DEFAULT_DETECT, SENSITIVITY_PRESETS } from "../../../src/detect/config.ts";
import type { DetectConfig, DetectSource } from "../../../src/types.ts";
import { api } from "../../api.ts";
import { ptzQuery } from "../../data/queries.ts";
import { maskEditor, type MaskEditor } from "../../detect/mask-editor.ts";
import { areaToPos, formatArea, posToArea, posToThreshold, sensitivityOf, thresholdToPos, type Sensitivity } from "../../detect/model.ts";
import { Choice, Segmented, Switch } from "../../ui/controls.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { SettingRow } from "../../ui/SettingRow.tsx";
import { Disclosure, Range } from "./bits.tsx";
import { ObjectSection } from "./ObjectSection.tsx";
import { ScoreMeter } from "./ScoreMeter.tsx";

const SNAPSHOT_MS = 2_000;


const SOURCES: { value: DetectSource; label: string; hint: string }[] = [
  { value: "pixel", label: "畫面變化", hint: "比對畫面的變化，每台攝影機都能用，也能排除不需要的區域。" },
  { value: "onvif", label: "相機偵測", hint: "用相機內建的偵測，不佔用這台電腦的資源，但不能排除區域。" },
  { value: "both", label: "兩者都用", hint: "任一個偵測到就算，比較不會漏掉。" },
];

const SENSITIVITY: { value: Sensitivity; label: string }[] = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "custom", label: "自訂" },
];

const SENSITIVITY_HINT: Record<Sensitivity, string> = {
  low: "只有明顯的動作才算，適合樹多、車多或光線常變的地方。",
  medium: "大多數情況的建議值。",
  high: "細微的變化也會偵測到，適合室內或想要不漏接。",
  custom: "往右越靈敏。",
};

/** 自訂靈敏度的文字描述，不顯示數字 */
function sensitivityWord(threshold: number): string {
  if (threshold <= SENSITIVITY_PRESETS.high) return "很靈敏";
  if (threshold <= SENSITIVITY_PRESETS.medium) return "偏靈敏";
  if (threshold <= SENSITIVITY_PRESETS.low) return "偏保守";
  return "很保守";
}

const sameMasks = (a: DetectConfig["masks"], b: DetectConfig["masks"]) => JSON.stringify(a) === JSON.stringify(b);

/** 排除區域編輯器加上每 2 秒換一次的快照：編輯器在 effect 建立、cleanup 拆掉；快照只在 live 為真時抓 */
function MaskPreview({ camera, masks, onMasks, live, children }: { camera: CameraDto; masks: DetectConfig["masks"]; onMasks: (m: DetectConfig["masks"]) => void; live: boolean; children: React.ReactNode }) {
  const shot = useRef<HTMLDivElement>(null);
  const after = useRef<HTMLParagraphElement>(null);
  const editor = useRef<MaskEditor | null>(null);
  const latest = useRef({ masks, onMasks });
  latest.current = { masks, onMasks };
  const ptz = useQuery(ptzQuery(camera.id));
  const onvifGuess = camera.config.connection.type === "tapo" || !!camera.config.connection.onvif;

  useEffect(() => {
    const ed = maskEditor(latest.current.masks, (m) => latest.current.onMasks(m));
    editor.current = ed;
    shot.current!.prepend(ed.stage);
    after.current!.before(ed.toolbar);
    return () => {
      ed.setImage(null);
      ed.stage.remove();
      ed.toolbar.remove();
      editor.current = null;
    };
  }, []);

  useEffect(() => {
    if (!live) return;
    let stopped = false;
    const load = async () => {
      const ed = editor.current;
      if (!ed) return;
      try {
        const res = await fetch(api.snapshotUrl(camera.id, Date.now()), { credentials: "same-origin" });
        if (stopped) return;
        if (!res.ok) return ed.setImage(null, res.status === 404 ? "這台攝影機已停用" : "目前拿不到畫面，相機可能連不上");
        const blob = await res.blob();
        if (!stopped) ed.setImage(URL.createObjectURL(blob));
      } catch {
        if (!stopped) ed.setImage(null, "目前拿不到畫面");
      }
    };
    void load();
    const timer = setInterval(() => !document.hidden && void load(), SNAPSHOT_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [live, camera.id]);

  // 能轉的鏡頭才需要提醒遮罩會錯位；問不到就照有沒有 ONVIF 猜
  const ptzNote = ptz.isError ? onvifGuess : ptz.data?.supported === true;
  return (
    <div className="detect-preview">
      <div ref={shot} className="detect-shot">
        {children}
      </div>
      <p ref={after} className="detect-ptz hint" hidden={!ptzNote}>
        <Icon name="info" size={15} />
        <span>排除區域是照畫面位置畫的。鏡頭轉到別的方向後會對不上，轉回原位就恢復；如果要長期換角度，記得重畫。</span>
      </p>
    </div>
  );
}

/**
 * 攝影機表單裡的「偵測」卡片內容。active 是卡片有沒有展開：收起來時關掉快照與畫面變化曲線（各佔一條連線）。
 * onvif 是表單上這台目前有沒有 ONVIF（Tapo 一定有；通用 RTSP 要開「使用 ONVIF」）。
 */
export function DetectSection({ camera, value, saved, onChange, onvif, active, objects }: { camera: CameraDto; value: DetectConfig; saved: DetectConfig; onChange: (patch: Partial<DetectConfig>) => void; onvif: boolean; active: boolean; objects: boolean }) {
  const [sens, setSens] = useState<Sensitivity>(() => sensitivityOf(value.threshold));
  const areaId = useId();
  const live = camera.config.enabled;
  const d = value;
  const pixel = d.enabled && d.source !== "onvif";
  const wantLive = live && pixel && active;
  const needOnvif = d.source !== "pixel" && !onvif;
  const areaText = `畫面的 ${formatArea(d.minArea)}`;

  return (
    <>
      <div className="detect-section set-rows">
        <SettingRow title="偵測動作" desc="有動靜時建立事件，之後可以在「事件」頁快速找到。" toggle control={(a) => <Switch {...a} checked={d.enabled} onChange={(v) => onChange({ enabled: v })} />} />
        <div className="set-rows" hidden={!d.enabled}>
          <SettingRow
            title="偵測方式"
            desc={SOURCES.find((s) => s.value === d.source)!.hint}
            wide
            control={<Segmented label="偵測方式" options={SOURCES.map(({ value, label }) => ({ value, label }))} value={d.source} onChange={(v) => onChange({ source: v })} />}
          />
          <div className="set-block" hidden={!needOnvif}>
            <p className="callout warn">
              <Icon name="alert" />
              <span>
                {d.source === "onvif"
                  ? "這台沒有設定 ONVIF，收不到相機的偵測。請在下方「進階設定」開啟「使用 ONVIF」，或改用畫面變化。"
                  : "這台沒有設定 ONVIF，目前只會用畫面變化偵測。要一起用相機偵測，請在下方「進階設定」開啟「使用 ONVIF」。"}
              </span>
            </p>
          </div>
          <div className="set-rows" hidden={!pixel}>
            <div className="set-block">
              {live ? (
                <MaskPreview camera={camera} masks={d.masks} onMasks={(masks) => onChange({ masks })} live={wantLive}>
                  <div className="detect-meter-slot">{wantLive ? <ScoreMeter cameraId={camera.id} minArea={d.minArea} threshold={d.threshold} thresholdPending={d.threshold !== saved.threshold} masksPending={!sameMasks(d.masks, saved.masks)} /> : null}</div>
                </MaskPreview>
              ) : (
                <div className="detect-preview-ph">
                  <span className="cam-ph">
                    <Icon name="power" size={22} />
                  </span>
                  <p>這台攝影機已停用。啟用並儲存後，才能在這裡看到畫面、畫出不需要偵測的區域。</p>
                </div>
              )}
            </div>
            <SettingRow
              title="靈敏度"
              desc={SENSITIVITY_HINT[sens]}
              wide
              control={
                <Segmented
                  label="靈敏度"
                  options={SENSITIVITY}
                  value={sens}
                  onChange={(v) => {
                    setSens(v);
                    if (v !== "custom") onChange({ threshold: SENSITIVITY_PRESETS[v] });
                  }}
                />
              }
            />
            <div className="set-block" hidden={sens !== "custom"}>
              <div className="range-field">
                <div className="range-label">
                  <span>自訂</span>
                  <span className="range-value">{sensitivityWord(d.threshold)}</span>
                </div>
                <div className="range-row">
                  <span className="range-end">保守</span>
                  <Range aria-label="自訂靈敏度" aria-valuetext={sensitivityWord(d.threshold)} initial={thresholdToPos(d.threshold)} onInput={(pos) => onChange({ threshold: posToThreshold(pos) })} />
                  <span className="range-end">靈敏</span>
                </div>
              </div>
            </div>
          </div>
          <Disclosure
            title="更多選項"
            summary={`${d.source !== "onvif" ? `變化範圍 ${formatArea(d.minArea)} · ` : ""}結束前等待 ${d.cooldownSec} 秒`}
            defaultOpen={d.minArea !== DEFAULT_DETECT.minArea || d.cooldownSec !== DEFAULT_DETECT.cooldownSec}
          >
            <div className="set-block" hidden={!pixel}>
              <div className="range-field">
                <div className="range-label">
                  <span id={areaId}>變化範圍超過</span>
                  <span className="range-value num">{areaText}</span>
                </div>
                <div className="range-row">
                  <span className="range-end">小</span>
                  <Range aria-labelledby={areaId} aria-valuetext={areaText} initial={areaToPos(d.minArea)} onInput={(pos) => onChange({ minArea: posToArea(pos) })} />
                  <span className="range-end">大</span>
                </div>
                <small className="hint">畫面裡有這麼大的範圍在變化，才算有動作。調大可以忽略小動物和落葉；即時畫面變化的曲線會跟著改。</small>
              </div>
            </div>
            <SettingRow
              title="動作停止後，再等多久結束事件"
              desc="等待期間又有動作，會算在同一筆事件裡。"
              wide
              control={
                <Choice
                  label="事件結束前等待"
                  presets={[5, 10, 30].map((v) => ({ value: v, label: `${v} 秒` }))}
                  initial={d.cooldownSec}
                  unit="秒"
                  onChange={(v) => Number.isFinite(v) && onChange({ cooldownSec: Math.min(300, Math.max(1, Math.round(v))) })}
                />
              }
            />
          </Disclosure>
        </div>
      </div>
      {objects && d.enabled ? (
        // 物件辨識緊接在動作偵測之後、同一張卡片裡
        <div className="detect-extra" data-slot="object-detection">
          <ObjectSection value={d} onChange={onChange} />
        </div>
      ) : null}
    </>
  );
}
