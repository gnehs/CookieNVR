import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type { CameraDto } from "../../../src/api-types.ts";
import { DEFAULT_DETECT, LIMITS, SENSITIVITY_PRESETS } from "../../../src/detect/config.ts";
import type { DetectConfig, DetectSource } from "../../../src/types.ts";
import { api } from "../../api.ts";
import { ptzQuery } from "../../data/queries.ts";
import { maskEditor, type MaskCopy, type MaskEditor } from "../../detect/mask-editor.ts";
import { modeOf } from "../../detect/object-model.ts";
import { areaToPos, formatArea, posToArea, posToThreshold, sensitivityOf, thresholdToPos, type Sensitivity } from "../../detect/model.ts";
import { Choice, Segmented, Switch } from "../../ui/controls.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { SettingRow, SettingsDisclosure } from "../../ui/SettingRow.tsx";
import { Range } from "./bits.tsx";
import { ObjectSection } from "./ObjectSection.tsx";
import { ScoreMeter } from "./ScoreMeter.tsx";

const SNAPSHOT_MS = 2_000;


const objectMaskCopy = (): MaskCopy => ({
  tag: t`Not detected`,
  empty: t`Draw the areas where objects don't need to be recognized, such as a parking spot. Motion is still detected inside, but things there won't get a category label.`,
  some: (count) => plural(count, { one: "# area where objects aren't detected. An object doesn't count when its center is inside. Click an area to adjust or delete it.", other: "# areas where objects aren't detected. An object doesn't count when its center is inside. Click an area to adjust or delete it." }),
  add: t`Add an area to ignore`,
});

const sources = (): { value: DetectSource; label: string; hint: string }[] => [
  { value: "pixel", label: t`Motion`, hint: t`Compares changes in the picture. Works with every camera and can exclude areas you don't need.` },
  { value: "onvif", label: t`Camera detection`, hint: t`Uses the camera's built-in detection. It doesn't use this computer's resources, but can't exclude areas.` },
  { value: "both", label: t`Both`, hint: t`Counts when either one detects something, so fewer things are missed.` },
];

const sensitivities = (): { value: Sensitivity; label: string }[] => [
  { value: "low", label: t`Low` },
  { value: "medium", label: t`Medium` },
  { value: "high", label: t`High` },
  { value: "custom", label: t`Custom` },
];

const sensitivityHint = (s: Sensitivity): string => {
  if (s === "low") return t`Only obvious motion counts. Good for places with many trees, cars, or changing light.`;
  if (s === "medium") return t`The recommended setting for most situations.`;
  if (s === "high") return t`Even subtle changes are detected. Good for indoors or when you don't want to miss anything.`;
  return t`The further right, the more sensitive.`;
};

/** 自訂靈敏度的文字描述，不顯示數字 */
function sensitivityWord(threshold: number): string {
  if (threshold <= SENSITIVITY_PRESETS.high) return t`Very sensitive`;
  if (threshold <= SENSITIVITY_PRESETS.medium) return t`Fairly sensitive`;
  if (threshold <= SENSITIVITY_PRESETS.low) return t`Fairly conservative`;
  return t`Very conservative`;
}

const sameMasks = (a: DetectConfig["masks"], b: DetectConfig["masks"]) => JSON.stringify(a) === JSON.stringify(b);

/** 排除區域編輯器加上每 2 秒換一次的快照：編輯器在 effect 建立、cleanup 拆掉；快照只在 live 為真時抓 */
function MaskPreview({ camera, masks, onMasks, live, copy, children }: { camera: CameraDto; masks: DetectConfig["masks"]; onMasks: (m: DetectConfig["masks"]) => void; live: boolean; copy?: MaskCopy; children?: React.ReactNode }) {
  const { t } = useLingui();
  const shot = useRef<HTMLDivElement>(null);
  const after = useRef<HTMLParagraphElement>(null);
  const editor = useRef<MaskEditor | null>(null);
  const latest = useRef({ masks, onMasks });
  latest.current = { masks, onMasks };
  const ptz = useQuery(ptzQuery(camera.id));
  const onvifGuess = camera.config.connection.type === "tapo" || !!camera.config.connection.onvif;

  useEffect(() => {
    const ed = maskEditor(latest.current.masks, (m) => latest.current.onMasks(m), copy);
    editor.current = ed;
    shot.current!.prepend(ed.stage);
    after.current!.before(ed.toolbar);
    return () => {
      ed.destroy();
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
        if (!res.ok) return ed.setImage(null, res.status === 404 ? t`This camera is disabled` : t`Can't get the picture right now. The camera may be unreachable.`);
        const blob = await res.blob();
        if (!stopped) ed.setImage(URL.createObjectURL(blob));
      } catch {
        if (!stopped) ed.setImage(null, t`Can't get the picture right now`);
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
      <div ref={shot} className="detect-shot" data-base-ui-swipe-ignore="">
        {children}
      </div>
      <p ref={after} className="detect-ptz hint" hidden={!ptzNote}>
        <Icon name="info" size={15} />
        <span>{t`Excluded areas are drawn at fixed positions in the picture. If the camera turns another way they no longer line up, and they match again when it returns. If you change the angle for good, redraw them.`}</span>
      </p>
    </div>
  );
}

/**
 * 攝影機設定裡的「偵測」對話框內容。active 是對話框有沒有打開：關起來時停掉快照與畫面變化曲線（各佔一條連線）。
 * onvif 是表單上這台目前有沒有 ONVIF（Tapo 一定有；通用 RTSP 要開「使用 ONVIF」）。
 */
export function DetectSection({ camera, value, saved, onChange, onvif, active, objects }: { camera: CameraDto; value: DetectConfig; saved: DetectConfig; onChange: (patch: Partial<DetectConfig>) => void; onvif: boolean; active: boolean; objects: boolean }) {
  const { t } = useLingui();
  const [sens, setSens] = useState<Sensitivity>(() => sensitivityOf(value.threshold));
  const areaId = useId();
  const live = camera.config.enabled;
  const d = value;
  const pixel = d.enabled && d.source !== "onvif";
  const wantLive = live && pixel && active;
  const needOnvif = d.source !== "pixel" && !onvif;
  const area = formatArea(d.minArea);
  const areaText = t`${area} of the picture`;
  const cooldown = d.cooldownSec;

  return (
    <>
      <div className="detect-section set-rows">
        <SettingRow title={t`Detect motion`} desc={t`Creates an event whenever something moves, so you can find it quickly on the Events page.`} toggle control={(a) => <Switch {...a} checked={d.enabled} onChange={(v) => onChange({ enabled: v })} />} />
        <div className="set-rows" hidden={!d.enabled}>
          <SettingRow
            title={t`Detection method`}
            desc={sources().find((s) => s.value === d.source)!.hint}
            wide
            control={<Segmented label={t`Detection method`} options={sources().map(({ value, label }) => ({ value, label }))} value={d.source} onChange={(v) => onChange({ source: v })} />}
          />
          <div className="set-block" hidden={!needOnvif}>
            <p className="callout warn">
              <Icon name="alert" />
              <span>
                {d.source === "onvif"
                  ? t`ONVIF isn't set up for this camera, so it can't receive the camera's detections. Turn on "Use ONVIF" under Connection → Advanced, or switch to motion detection.`
                  : t`ONVIF isn't set up for this camera, so only motion detection is used for now. To use camera detection too, turn on "Use ONVIF" under Connection → Advanced.`}
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
                  <p>{t`This camera is disabled. Enable it and save to see the picture here and draw areas that shouldn't be detected.`}</p>
                </div>
              )}
            </div>
            <SettingRow
              title={t`Sensitivity`}
              desc={sensitivityHint(sens)}
              wide
              control={
                <Segmented
                  label={t`Sensitivity`}
                  options={sensitivities()}
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
                  <span>{t`Custom`}</span>
                  <span className="range-value">{sensitivityWord(d.threshold)}</span>
                </div>
                <div className="range-row">
                  <span className="range-end">{t`Conservative`}</span>
                  <Range aria-label={t`Custom sensitivity`} aria-valuetext={sensitivityWord(d.threshold)} initial={thresholdToPos(d.threshold)} onInput={(pos) => onChange({ threshold: posToThreshold(pos) })} />
                  <span className="range-end">{t`Sensitive`}</span>
                </div>
              </div>
            </div>
          </div>
          <SettingsDisclosure
            title={t`More options`}
            summary={`${d.source !== "onvif" ? `${t`Change area ${area}`} · ` : ""}${t`Waits ${cooldown} sec before ending`}`}
            defaultOpen={d.minArea !== DEFAULT_DETECT.minArea || d.cooldownSec !== DEFAULT_DETECT.cooldownSec || d.maxEventSec !== DEFAULT_DETECT.maxEventSec}
          >
            <div className="set-block" hidden={!pixel}>
              <div className="range-field">
                <div className="range-label">
                  <span id={areaId}>{t`Change area larger than`}</span>
                  <span className="range-value num">{areaText}</span>
                </div>
                <div className="range-row">
                  <span className="range-end">{t`Small`}</span>
                  <Range aria-labelledby={areaId} aria-valuetext={areaText} initial={areaToPos(d.minArea)} onInput={(pos) => onChange({ minArea: posToArea(pos) })} />
                  <span className="range-end">{t`Large`}</span>
                </div>
                <small className="hint">{t`Motion counts only when an area this large changes. Raise it to ignore small animals and falling leaves. The live motion curve follows.`}</small>
              </div>
            </div>
            <SettingRow
              title={t`How long to wait after motion stops before ending the event`}
              desc={t`Motion during the wait counts toward the same event.`}
              wide
              control={
                <Choice
                  label={t`Wait before ending the event`}
                  presets={[5, 10, 30].map((v) => ({ value: v, label: t`${v} sec` }))}
                  initial={d.cooldownSec}
                  unit={t`sec`}
                  onChange={(v) => Number.isFinite(v) && onChange({ cooldownSec: Math.min(300, Math.max(1, Math.round(v))) })}
                />
              }
            />
            <SettingRow
              title={t`Longest event`}
              desc={t`Motion that lasts longer is split into a new event, which notifies again. Shorter events give shorter clips to send.`}
              wide
              control={
                <Choice
                  label={t`Longest event`}
                  presets={[2, 5, 10, 30].map((v) => ({ value: v, label: t`${v} min` }))}
                  initial={d.maxEventSec / 60}
                  unit={t`min`}
                  onChange={(v) => Number.isFinite(v) && onChange({ maxEventSec: Math.min(LIMITS.maxEventSec.max, Math.max(LIMITS.maxEventSec.min, Math.round(v * 60))) })}
                />
              }
            />
          </SettingsDisclosure>
        </div>
      </div>
      {objects && d.enabled ? (
        // 物件辨識緊接在動作偵測之後、同一個對話框裡
        <div className="detect-extra" data-slot="object-detection">
          <ObjectSection
            value={d}
            onChange={onChange}
            zones={
              live ? <MaskPreview camera={camera} masks={d.objectMasks} onMasks={(objectMasks) => onChange({ objectMasks })} live={active && modeOf(d.objectMode) !== "off"} copy={objectMaskCopy()} /> : null
            }
          />
        </div>
      ) : null}
    </>
  );
}
