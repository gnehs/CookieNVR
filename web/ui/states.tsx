import type { ReactNode } from "react";
import { errMsg } from "../format.ts";
import { Button, ButtonLink } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.ts";

export function Spinner({ label = "載入中…" }: { label?: string }) {
  return (
    <div className="state loading" role="status">
      <span className="spin" />
      <span>{label}</span>
    </div>
  );
}

/** 整頁的空白、錯誤狀態共用同一個置中版面 */
function StateBox({ kind, icon, title, body, actions }: { kind: "empty" | "error"; icon: IconName; title: string; body?: string; actions?: ReactNode }) {
  return (
    <div className={`state ${kind}`} role={kind === "error" ? "alert" : undefined}>
      <span className="state-ico">
        <Icon name={icon} size={22} />
      </span>
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
      {actions ? <div className="state-actions">{actions}</div> : null}
    </div>
  );
}

/** 頁面載入時的已知錯誤（例如找不到資料），自帶標題與主要動作；其他錯誤當成暫時性的，給「重新載入」 */
export class PageError extends Error {
  constructor(
    readonly title: string,
    message: string,
    readonly action: { label: string; to: string },
  ) {
    super(message);
  }
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (error instanceof PageError) {
    return (
      <StateBox
        kind="error"
        icon="alert"
        title={error.title}
        body={error.message}
        actions={
          <ButtonLink to={error.action.to} variant="primary">
            {error.action.label}
          </ButtonLink>
        }
      />
    );
  }
  return (
    <StateBox
      kind="error"
      icon="alert"
      title="這裡暫時打不開"
      body={errMsg(error)}
      actions={
        onRetry ? (
          <Button icon="refresh" onClick={onRetry}>
            重新載入
          </Button>
        ) : null
      }
    />
  );
}

export function EmptyState({ title, body, action, icon = "film" }: { title: string; body?: string; action?: ReactNode; icon?: IconName }) {
  return <StateBox kind="empty" icon={icon} title={title} body={body} actions={action} />;
}
