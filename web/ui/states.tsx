import { useLingui } from "@lingui/react/macro";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { errMsg } from "../format.ts";
import { Button, ButtonLink } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.ts";

export function Spinner({ label }: { label?: string }) {
  const { t } = useLingui();
  return (
    <div className="state loading" role="status">
      <span className="spin" />
      <span>{label ?? t`Loading…`}</span>
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
  const { t } = useLingui();
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
      title={t`Can't open this right now`}
      body={errMsg(error)}
      actions={
        onRetry ? (
          <Button icon="refresh" onClick={onRetry}>
            {t`Reload`}
          </Button>
        ) : null
      }
    />
  );
}

export function EmptyState({ title, body, action, icon = "film" }: { title: string; body?: string; action?: ReactNode; icon?: IconName }) {
  return <StateBox kind="empty" icon={icon} title={title} body={body} actions={action} />;
}

type Loaded<Q> = Q extends UseQueryResult<infer D, unknown> ? Exclude<D, undefined> : never;

/**
 * 這幾個查詢都有資料才畫 children，否則畫標準的錯誤（第一個失敗的查詢，重試只重抓它）或載入中。
 * children 拿到的資料不含 undefined；它不是元件，裡面不能用 hook。
 */
export function QueryGate<const T extends readonly UseQueryResult<any, any>[]>({ queries, children }: { queries: T; children: (data: { [K in keyof T]: Loaded<T[K]> }) => ReactNode }) {
  const failed = queries.find((q) => q.isError);
  if (failed) return <ErrorBox error={failed.error} onRetry={() => void failed.refetch()} />;
  if (queries.some((q) => q.data === undefined)) return <Spinner />;
  return <>{children(queries.map((q) => q.data) as { [K in keyof T]: Loaded<T[K]> })}</>;
}
