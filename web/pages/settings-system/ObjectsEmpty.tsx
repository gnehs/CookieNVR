import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, type CSSProperties } from "react";
import { Button } from "../../ui/Button.tsx";

const BOXES: { x: number; y: number; w: number; h: number; label: MessageDescriptor }[] = [
  { x: 92, y: 110, w: 40, h: 44, label: msg`Cat 88%` },
  { x: 150, y: 80, w: 44, h: 74, label: msg`Person 96%` },
  { x: 206, y: 100, w: 98, h: 58, label: msg`Car 91%` },
];

/** 監視畫面裡的人、車、貓各被框起來；被風吹動的樹沒有框，表示樹影晃動不會被記成事件。顏色全在 CSS（.obj-empty-art） */
function Art() {
  const { i18n } = useLingui();
  const id = useId();
  const sky = `${id}-sky`;
  const frame = `${id}-frame`;
  return (
    <svg className="obj-empty-art" viewBox="0 0 320 188" aria-hidden="true">
      <defs>
        <linearGradient id={sky} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--ill-sky-1)" />
          <stop offset="1" stopColor="var(--ill-sky-2)" />
        </linearGradient>
        <clipPath id={frame}>
          <rect x="1" y="1" width="318" height="186" rx="18" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${frame})`}>
        <rect width="320" height="188" fill={`url(#${sky})`} />
        <circle cx="282" cy="40" r="13" fill="var(--ill-sun)" />
        <path d="M0 122 Q70 94 140 116 T320 106 V188 H0 Z" fill="var(--ill-hill)" />
        <rect y="134" width="320" height="54" fill="var(--ill-ground)" />

        <rect x="46" y="104" width="7" height="44" rx="3" fill="var(--ill-trunk)" />
        <g fill="var(--ill-tree)">
          <circle cx="50" cy="86" r="22" />
          <circle cx="36" cy="102" r="14" />
          <circle cx="64" cy="102" r="14" />
        </g>
        <g fill="none" stroke="var(--ill-wind)" strokeWidth="2.2" strokeLinecap="round">
          <path d="M78 72 q8 -5 16 0" />
          <path d="M82 84 q6 -4 12 0" />
        </g>

        <g fill="var(--ill-ink)">
          <ellipse cx="110" cy="141" rx="12" ry="8" />
          <circle cx="121" cy="129" r="7" />
          <path d="M115.5 125 l1 -8 l5 5 z M121 122 l5 -5 l1.5 8 z" />
          <circle cx="172" cy="96" r="9" />
          <rect x="161" y="107" width="22" height="26" rx="10" />
          <rect x="163" y="126" width="8" height="24" rx="4" />
          <rect x="173" y="126" width="8" height="24" rx="4" />
          <path d="M214 146 v-14 a7 7 0 0 1 7 -7 h6 l13 -14 h30 l13 14 h5 a7 7 0 0 1 7 7 v14 z" />
        </g>
        <path d="M99 144 q-9 -2 -6 -13" fill="none" stroke="var(--ill-ink)" strokeWidth="4" strokeLinecap="round" />
        <path d="M245 124 l8 -9 h11 v9 z M268 124 v-9 h3 l8 9 z" fill="var(--ill-glass)" />
        <g fill="var(--ill-wheel)">
          <circle cx="232" cy="146" r="9" />
          <circle cx="278" cy="146" r="9" />
        </g>
        <g fill="var(--ill-ink)">
          <circle cx="232" cy="146" r="3.5" />
          <circle cx="278" cy="146" r="3.5" />
        </g>

        {BOXES.map((b, i) => (
          <g className="obj-empty-box" style={{ "--i": i } as CSSProperties} key={b.label.message}>
            <rect className="obj-empty-box-frame" x={b.x} y={b.y} width={b.w} height={b.h} rx="6" />
            <rect className="obj-empty-box-tag" x={b.x} y={b.y - 16} width="58" height="14" rx="7" />
            <text className="obj-empty-box-text" x={b.x + 29} y={b.y - 6} textAnchor="middle">
              {i18n._(b.label)}
            </text>
          </g>
        ))}
      </g>
      <rect className="obj-empty-art-edge" x="1" y="1" width="318" height="186" rx="18" fill="none" />
    </svg>
  );
}

/** 物件辨識還沒開：插圖、說明與開啟按鈕，取代只有一個開關的卡片 */
export function ObjectsEmpty({ busy, onEnable }: { busy: boolean; onEnable: () => void }) {
  const { t } = useLingui();
  return (
    <section className="set-card obj-empty" aria-labelledby="obj-empty-title">
      <Art />
      <h2 id="obj-empty-title">{t`Recognize people, vehicles and animals in the picture`}</h2>
      <p>
        <Trans>Once on, each camera can choose to record events only when it sees a person, vehicle or animal, so wind in the leaves and changing light no longer fill up the event list. It uses some extra computer resources.</Trans>
      </p>
      <Button variant="primary" disabled={busy} aria-busy={busy || undefined} onClick={onEnable}>
        {busy ? <span className="spin" /> : null}
        {t`Turn on object detection`}
      </Button>
    </section>
  );
}
