import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Icon } from "../../ui/Icon.tsx";
import { useIndicator } from "../../ui/indicator.ts";
import { PageHeader } from "../../ui/Panel.tsx";

export const SETTINGS_TABS = [
  ["cameras", "攝影機"],
  ["storage", "錄影與儲存"],
  ["system", "一般"],
  ["users", "使用者"],
  ["status", "狀態"],
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number][0];

/** 設定的分頁：標題「設定」加上分頁列 */
export function SettingsLayout({ active, children }: { active: SettingsTab; children?: ReactNode }) {
  const tabs = useIndicator<HTMLElement>('a[aria-current="page"]', active, "settings-tabs");
  return (
    <div className="form-page">
      <PageHeader title="設定" />
      <nav className="pill-nav" aria-label="設定分頁" ref={tabs.container}>
        <div className="ind pill-ind" ref={tabs.block} aria-hidden="true" />
        {SETTINGS_TABS.map(([key, label]) => (
          <Link key={key} to={`/settings/${key}`} aria-current={key === active ? "page" : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}

/** 設定裡的子頁（新增、編輯）：不放分頁列，只留返回與標題 */
export function SettingsSubpage({ title, back, children }: { title: string; back: string; children?: ReactNode }) {
  return (
    <div className="form-page">
      <header className="page-head sub-head">
        <Link className="back-btn" to={back} aria-label="返回">
          <Icon name="left" size={18} />
        </Link>
        <h1>{title}</h1>
      </header>
      {children}
    </div>
  );
}
