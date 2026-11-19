import { cloneElement, useId, type ReactElement } from "react";
import { Icon } from "./Icon.tsx";

/**
 * 表單欄位：標題、輸入元素、說明文字（`.field`）。輸入元素的 id 與 aria-describedby 由這裡接好，
 * 傳進來的 `<input>`、`<textarea>` 或 `<Select>` 不用自己給 id。
 */
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }> }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id, "aria-describedby": hintId, "aria-invalid": error ? true : undefined })}
      {hint ? (
        <small id={hintId} className="hint">
          {hint}
        </small>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          <Icon name="alert-circle" size={15} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
