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

const moreTitle = (n: number) => (n > 0 ? `更多類別（已選 ${n}）` : "更多類別");

/** 偵測卡片裡的「物件辨識」：模式、關注的類別、嚴格程度。只有系統設定開了物件辨識、而且這台開了動作偵測才畫出來 */
export function ObjectSection({ value, onChange }: { value: ObjectFields; onChange: (patch: Partial<ObjectFields>) => void }) {
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
      ? "自訂模型還沒載入過，類別清單暫時是內建模型的，載入後會更新。"
      : g.noPackage
        ? catalog.model === "builtin"
          ? "內建模型不含包裹；要辨識包裹需要放入含有這個類別的自訂模型。"
          : "目前的模型沒有包裹這個類別。"
        : null;
  const problem = labelsProblem(mode, value.labels);
  const strict = STRICTNESS[strictnessOf(value.objectScore)];

  return (
    <div className="set-rows obj-section">
      <SettingRow
        title="物件辨識"
        desc={OBJECT_MODES.find((m) => m.value === mode)!.desc}
        wide
        control={
          <Segmented
            label="物件辨識"
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
        <span className="set-row-title">要注意的東西</span>
        <div className="obj-labels" role="group" aria-label="要注意的東西">
          {g.common.map((l) => box(l.key, l.zh))}
        </div>
        <details ref={more} className="detect-more obj-more" hidden={g.more.length === 0} onToggle={() => (touched.current = true)}>
          <summary>
            <Icon name="chevron" size={15} />
            <span>{moreTitle(g.more.filter((l) => value.labels.includes(l.key)).length)}</span>
          </summary>
          <div className="detect-more-body">
            <div className="obj-labels" role="group" aria-label="更多類別">
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
            <span>嚴格程度</span>
            <span className="range-value">{strict.word}</span>
          </div>
          <div className="range-row">
            <span className="range-end">寬鬆</span>
            <Range aria-label="嚴格程度" aria-valuetext={strict.word} step={100 / 13} initial={scoreToPos(value.objectScore)} onInput={(pos) => onChange({ objectScore: posToScore(pos) })} />
            <span className="range-end">嚴格</span>
          </div>
          <small className="hint">{strict.hint}</small>
        </div>
      </div>
    </div>
  );
}
