import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { ObjectLabelsDto } from "../../../src/api-types.ts";
import { COMMON_LABELS, labelName } from "../../../src/objects/labels.ts";
import type { DetectConfig } from "../../../src/types.ts";
import { objectLabelsQuery } from "../../data/queries.ts";
import { labelGroups, labelsProblem, modeOf, OBJECT_MODES, posToScore, scoreToPos, STRICTNESS, strictnessOf } from "../../detect/object-model.ts";
import { Segmented } from "../../ui/controls.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { SettingRow } from "../../ui/SettingRow.tsx";
import { Range } from "./bits.tsx";

export type ObjectFields = Pick<DetectConfig, "labels" | "objectMode" | "objectScore">;


/** 類別目錄還沒到、或抓不到時的備用清單：只有常用類別 */
const FALLBACK: Pick<ObjectLabelsDto, "labels" | "common"> = { labels: COMMON_LABELS.map((key) => ({ key, zh: labelName(key), en: key })), common: [...COMMON_LABELS] };

/** 偵測設定裡的「物件辨識」：模式、關注的類別、嚴格程度。只有系統設定開了物件辨識、而且這台開了動作偵測才畫出來 */
export function ObjectSection({ value, onChange, zones }: { value: ObjectFields; onChange: (patch: Partial<ObjectFields>) => void; zones?: React.ReactNode }) {
  const { t } = useLingui();
  const catalog = useQuery(objectLabelsQuery).data ?? null;
  const mode = modeOf(value.objectMode);
  const g = labelGroups(catalog ?? FALLBACK, value.labels);
  const more = useRef<HTMLDetailsElement>(null);
  const touched = useRef(false);
  useEffect(() => {
    if (g.moreHasSelected && !touched.current && more.current) more.current.open = true;
  }, [g.moreHasSelected]);

  const toggle = (key: string, on: boolean) => onChange({ labels: on ? [...value.labels, key] : value.labels.filter((k) => k !== key) });
  const box = (key: string, zh: string) => (
    <label className="obj-label" key={key}>
      <input type="checkbox" value={key} checked={value.labels.includes(key)} onChange={(e) => toggle(key, e.currentTarget.checked)} />
      <span>
        <Icon name="check" size={15} />
        {zh}
      </span>
    </label>
  );
  const note = !catalog
    ? null
    : !catalog.known
      ? t`The custom model hasn't been loaded yet, so the category list is the built-in model's for now. It updates once loaded.`
      : g.noPackage
        ? catalog.model === "builtin"
          ? t`The built-in model doesn't include packages. To detect packages, add a custom model that has this category.`
          : t`The current model has no package category.`
        : null;
  const problem = labelsProblem(mode, value.labels);
  const strict = STRICTNESS[strictnessOf(value.objectScore)];
  const moreSelected = g.more.filter((l) => value.labels.includes(l.key)).length;
  const moreTitle = moreSelected > 0 ? t`More categories (${moreSelected} selected)` : t`More categories`;

  return (
    <div className="set-rows obj-section">
      <SettingRow
        title={t`Object detection`}
        desc={OBJECT_MODES.find((m) => m.value === mode)!.desc}
        wide
        control={
          <Segmented
            label={t`Object detection`}
            options={OBJECT_MODES.map(({ value, label }) => ({ value, label }))}
            value={mode}
            onChange={(v) =>
              // 這台原本是「不辨識」時，生效的勾選是空的（後端不對外給）；切到標註或過濾就預設勾上人
              onChange(v !== "off" && value.labels.length === 0 ? { objectMode: v, labels: ["person"] } : { objectMode: v })
            }
          />
        }
      />
      <div className="set-block obj-block" hidden={mode === "off"}>
        <span className="set-row-title">{t`What to watch for`}</span>
        <div className="obj-labels" role="group" aria-label={t`What to watch for`}>
          {g.common.map((l) => box(l.key, l.zh))}
        </div>
        <details ref={more} className="detect-more obj-more" hidden={g.more.length === 0} onToggle={() => (touched.current = true)}>
          <summary>
            <Icon name="chevron" size={15} />
            <span>{moreTitle}</span>
          </summary>
          <div className="detect-more-body">
            <div className="obj-labels" role="group" aria-label={t`More categories`}>
              {g.more.map((l) => box(l.key, l.zh))}
            </div>
          </div>
        </details>
        <small className="hint" hidden={!note}>
          {note}
        </small>
        <p className="callout warn" role="status" hidden={!problem}>
          <Icon name="alert" />
          <span>{problem}</span>
        </p>
      </div>
      <div className="set-block obj-block" hidden={mode === "off"}>
        <div className="range-field">
          <div className="range-label">
            <span>{t`Strictness`}</span>
            <span className="range-value">{strict.word}</span>
          </div>
          <div className="range-row">
            <span className="range-end">{t`Lenient`}</span>
            <Range aria-label={t`Strictness`} aria-valuetext={strict.word} step={100 / 13} initial={scoreToPos(value.objectScore)} onInput={(pos) => onChange({ objectScore: posToScore(pos) })} />
            <span className="range-end">{t`Strict`}</span>
          </div>
          <small className="hint">{strict.hint}</small>
        </div>
      </div>
      <div className="set-block obj-block" hidden={mode === "off" || !zones}>
        <span className="set-row-title">{t`Areas to ignore`}</span>
        {zones}
      </div>
    </div>
  );
}
