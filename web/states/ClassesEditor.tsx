import { useRef } from "react";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { MAX_CLASS_NAME, MAX_CLASSES, type ClassRow } from "./model.ts";

let seq = 0;

/**
 * 類別清單：每一類一個欄位，可以改名、刪除、新增。counts 有給時，刪除鈕旁邊顯示已標記的張數，
 * 讓人知道刪了會影響多少。
 */
export function ClassesEditor({ rows, onRows, invalid, counts }: { rows: ClassRow[]; onRows: (rows: ClassRow[]) => void; invalid: number | null; counts?: Map<string, number> }) {
  const list = useRef<HTMLOListElement>(null);
  const add = () => {
    onRows([...rows, { key: `new${++seq}`, original: null, name: "" }]);
    requestAnimationFrame(() => list.current?.querySelector<HTMLInputElement>("li:last-child input")?.focus());
  };
  return (
    <div className="cls-edit">
      <ol ref={list} className="cls-list">
        {rows.map((r, i) => {
          const n = r.original ? (counts?.get(r.original) ?? 0) : 0;
          return (
            <li key={r.key}>
              <span className="cls-num num" aria-hidden="true">
                {i + 1}
              </span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={MAX_CLASS_NAME}
                aria-label={`第 ${i + 1} 類的名稱`}
                aria-invalid={invalid === i || undefined}
                placeholder={i === 0 ? "例如：關" : i === 1 ? "例如：開" : "例如：移動中"}
                value={r.name}
                onChange={(e) => onRows(rows.map((x) => (x.key === r.key ? { ...x, name: e.currentTarget.value } : x)))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (i === rows.length - 1 && rows.length < MAX_CLASSES) add();
                    else list.current?.querySelectorAll<HTMLInputElement>("input")[i + 1]?.focus();
                  }
                }}
              />
              {counts && n > 0 ? <span className="cls-count num">{n} 張</span> : null}
              <Button small variant="ghost" iconOnly icon="x" iconSize={16} aria-label={`刪除「${r.name || `第 ${i + 1} 類`}」`} disabled={rows.length <= 2} onClick={() => onRows(rows.filter((x) => x.key !== r.key))} />
            </li>
          );
        })}
      </ol>
      <div className="cls-foot">
        <Button small icon="plus" iconSize={15} onClick={add} disabled={rows.length >= MAX_CLASSES}>
          新增類別
        </Button>
        <p className="hint">
          <Icon name="info" size={14} />
          開關之間的過渡（例如「移動中」）可以另外加一類，不加也可以。
        </p>
      </div>
    </div>
  );
}
