import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import logoUrl from "../assets/logo.png";
import { Icon } from "./Icon.tsx";

export function PageHeader({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <h1>{title}</h1>
      {children}
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

/** 巢狀面板：外框帶標題列，內面板放 section，底部可選動作列 */
export function Panel(props: {
  title?: ReactNode;
  /** 返回按鈕的目的地 */
  back?: string;
  actions?: ReactNode;
  foot?: ReactNode;
  className?: string;
  flush?: boolean;
  children?: ReactNode;
}) {
  const { t } = useLingui();
  const head = props.title || props.back || props.actions;
  return (
    <section className={`panel${props.className ? ` ${props.className}` : ""}`}>
      {head ? (
        <div className="panel-head">
          {props.back ? (
            <Link className="back-btn" to={props.back} aria-label={t`Back`}>
              <Icon name="left" size={16} />
            </Link>
          ) : null}
          {props.title ? <h2>{props.title}</h2> : <span style={{ flex: 1 }} />}
          {props.actions}
        </div>
      ) : null}
      <div className={`panel-body${props.flush ? " flush" : ""}`}>{props.children}</div>
      {props.foot ? <div className="panel-foot">{props.foot}</div> : null}
    </section>
  );
}

export function PanelSection({ title, desc, children }: { title?: string; desc?: string; children?: ReactNode }) {
  return (
    <div className="panel-section">
      {title || desc ? (
        <header>
          {title ? <h3>{title}</h3> : null}
          {desc ? <p>{desc}</p> : null}
        </header>
      ) : null}
      {children}
    </div>
  );
}

export function Badge({ kind = "muted", children }: { kind?: "ok" | "bad" | "warn" | "muted"; children: ReactNode }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

/** 品牌圖示：由 design/CookieNVR.icon 匯出 */
export function BrandMark() {
  return <img className="brand-mark" src={logoUrl} alt="" width="30" height="30" />;
}
