import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { CropBox } from "../../src/api-types.ts";
import { api } from "../api.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { moveRect, rectFrom, resizeRect, roundCrop } from "./model.ts";

/** 拖曳中的動作：畫新的框、移動整個框、拉某個角或邊 */
type Drag = { kind: "draw"; anchor: [number, number] } | { kind: "move"; start: [number, number]; from: CropBox } | { kind: "resize"; handle: string };

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
const CORNERS = new Set(["nw", "ne", "se", "sw"]);
const HANDLE_NAME: Record<string, MessageDescriptor> = { nw: msg`Top left corner`, ne: msg`Top right corner`, se: msg`Bottom right corner`, sw: msg`Bottom left corner` };

type Shot = { state: "loading" } | { state: "ok"; src: string; w: number; h: number } | { state: "failed" };

/**
 * 在攝影機最新的快照上框一塊矩形：在空白處拖曳畫新的框、拖框移動、拖角或邊調整大小；
 * 框和角都能用方向鍵（按住 Shift 移動較多）。旁邊的小圖是辨識時實際會看到的畫面（拉成正方形）。
 */
export function CropEditor({ cameraId, value, onChange }: { cameraId: string; value: CropBox; onChange: (c: CropBox) => void }) {
  const { t, i18n } = useLingui();
  const stage = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const img = useRef<HTMLImageElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const [shot, setShot] = useState<Shot>({ state: "loading" });
  const [round, setRound] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    let stopped = false;
    setShot((s) => (s.state === "ok" ? s : { state: "loading" }));
    (async () => {
      try {
        const res = await fetch(api.snapshotUrl(cameraId, Date.now()), { credentials: "same-origin" });
        if (!res.ok) throw new Error();
        url = URL.createObjectURL(await res.blob());
        const im = new Image();
        im.src = url;
        await im.decode();
        if (stopped) return;
        img.current = im;
        setShot({ state: "ok", src: url, w: im.naturalWidth, h: im.naturalHeight });
      } catch {
        if (!stopped) setShot({ state: "failed" });
      }
    })();
    return () => {
      stopped = true;
      // 換新快照時，上一張要等新的畫好才釋放
      const old = url;
      if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
    };
  }, [cameraId, round]);

  // 小預覽：框裡的畫面拉成正方形，就是辨識時看到的樣子
  useEffect(() => {
    const c = preview.current;
    const im = img.current;
    if (!c || !im || shot.state !== "ok") return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const [x1, y1, x2, y2] = value;
    ctx.drawImage(im, x1 * shot.w, y1 * shot.h, (x2 - x1) * shot.w, (y2 - y1) * shot.h, 0, 0, c.width, c.height);
  }, [value, shot]);

  const toLocal = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = stage.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };

  const begin = (e: ReactPointerEvent, d: Drag) => {
    if (!e.isPrimary || e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();
    stage.current!.setPointerCapture(e.pointerId);
    drag.current = d;
    setDragging(true);
  };

  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toLocal(e);
    if (d.kind === "draw") onChange(rectFrom(d.anchor, p));
    else if (d.kind === "move") onChange(moveRect(d.from, p[0] - d.start[0], p[1] - d.start[1]));
    else onChange(resizeRect(value, d.handle, p[0], p[1]));
  };

  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    onChange(roundCrop(value));
  };

  const step = (e: KeyboardEvent) => (e.shiftKey ? 0.05 : 0.01);
  const arrows = (e: KeyboardEvent): [number, number] | null => {
    const s = step(e);
    const d: Record<string, [number, number]> = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] };
    return d[e.key] ?? null;
  };

  const cornerLabel = (h: string) => {
    const corner = i18n._(HANDLE_NAME[h]!);
    return t`${corner}, resize with the arrow keys`;
  };

  const [x1, y1, x2, y2] = value;
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  const ratio = shot.state === "ok" ? `${shot.w} / ${shot.h}` : "16 / 9";

  return (
    <div className="crop">
      <div className="crop-main">
        <div
          ref={stage}
          className="crop-stage"
          style={{ aspectRatio: ratio }}
          data-dragging={dragging ? "" : undefined}
          onPointerDown={(e) => begin(e, { kind: "draw", anchor: toLocal(e) })}
          onPointerMove={onMove}
          onPointerUp={end}
          onPointerCancel={end}
        >
          {shot.state === "ok" ? <img className="crop-img" src={shot.src} alt="" draggable={false} /> : null}
          {shot.state !== "ok" ? (
            <span className="crop-ph">
              {shot.state === "loading" ? <span className="spin" aria-hidden="true" /> : <Icon name="camera" size={24} />}
              <span>{shot.state === "loading" ? t`Getting the picture…` : t`Can’t get this camera’s picture. Draw a rough box for now and adjust it later.`}</span>
            </span>
          ) : null}
          <span className="crop-shade" aria-hidden="true" style={{ left: 0, top: 0, right: 0, height: pct(y1) }} />
          <span className="crop-shade" aria-hidden="true" style={{ left: 0, top: pct(y2), right: 0, bottom: 0 }} />
          <span className="crop-shade" aria-hidden="true" style={{ left: 0, top: pct(y1), width: pct(x1), height: pct(y2 - y1) }} />
          <span className="crop-shade" aria-hidden="true" style={{ left: pct(x2), top: pct(y1), right: 0, height: pct(y2 - y1) }} />
          <div
            className="crop-box"
            style={{ left: pct(x1), top: pct(y1), width: pct(x2 - x1), height: pct(y2 - y1) }}
            tabIndex={0}
            role="group"
            aria-label={t`Detection area. Move it with the arrow keys; hold Shift to move further.`}
            onPointerDown={(e) => begin(e, { kind: "move", start: toLocal(e), from: value })}
            onKeyDown={(e) => {
              const d = arrows(e);
              if (!d) return;
              e.preventDefault();
              onChange(roundCrop(moveRect(value, d[0], d[1])));
            }}
          >
            {HANDLES.map((h) => (
              <button
                key={h}
                type="button"
                className={`crop-handle ${h}`}
                tabIndex={CORNERS.has(h) ? 0 : -1}
                aria-label={CORNERS.has(h) ? cornerLabel(h) : undefined}
                aria-hidden={CORNERS.has(h) ? undefined : true}
                onPointerDown={(e) => begin(e, { kind: "resize", handle: h })}
                onKeyDown={(e) => {
                  const d = arrows(e);
                  if (!d) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const cx = h.includes("w") ? x1 : x2;
                  const cy = h.includes("n") ? y1 : y2;
                  onChange(roundCrop(resizeRect(value, h, cx + d[0], cy + d[1])));
                }}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="crop-side">
        <figure className="crop-preview">
          <canvas ref={preview} width={160} height={160} hidden={shot.state !== "ok"} aria-hidden="true" />
          {shot.state !== "ok" ? <span className="crop-preview-ph" aria-hidden="true" /> : null}
          <figcaption>{t`What detection sees`}</figcaption>
        </figure>
        <p className="hint"><Trans>Box the thing to check (for example the whole door) and leave a little margin. Drag on an empty spot to redraw.</Trans></p>
        <Button small icon="refresh" iconSize={15} onClick={() => setRound((n) => n + 1)} disabled={shot.state === "loading"}>
          <Trans>Refresh picture</Trans>
        </Button>
      </div>
    </div>
  );
}
