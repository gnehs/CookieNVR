import type { ReactNode } from "react";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.ts";

/**
 * 表單裡可以收合的一張卡片：標題列是 `<summary>`（展開狀態由瀏覽器提供），收合時顯示一行摘要，
 * 右邊是錯誤與未儲存的標示。以共用的 details.disclosure 為基礎，展開動畫一致。
 */
export function FormCard(props: { title: string; icon: IconName; defaultOpen?: boolean; summary?: string; error?: boolean; dirty?: boolean; className?: string; children?: ReactNode }) {
  return (
    <details
      className={`disclosure fcard${props.className ? ` ${props.className}` : ""}`}
      open={props.defaultOpen}
      data-error={props.error ? "" : undefined}
      data-dirty={props.dirty ? "" : undefined}
    >
      <summary>
        <span className="fcard-ico">
          <Icon name={props.icon} size={18} />
        </span>
        <span className="fcard-text">
          <b>{props.title}</b>
          <small className="fcard-sub">{props.summary}</small>
        </span>
        <span className="fcard-flags">
          <span className="fcard-flag error" hidden={!props.error}>
            <Icon name="alert-circle" size={14} />
            有錯誤
          </span>
          <span className="fcard-flag dirty" hidden={!props.dirty}>
            <i aria-hidden="true" />
            未儲存
          </span>
        </span>
        <span className="fcard-chevron">
          <Icon name="down" size={18} />
        </span>
      </summary>
      <div className="fcard-body">{props.children}</div>
    </details>
  );
}
