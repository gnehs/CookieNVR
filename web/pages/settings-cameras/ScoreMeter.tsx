import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { DetectFrameState, MotionSampleDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { meterY, TRIGGER_Y } from "../../detect/model.ts";
import { DETECT_FRAME_TEXT, MOTION_LEVEL_TEXT } from "../../health.ts";

/** 曲線顯示最近這麼久 */
const WINDOW_MS = 30_000;
const HEIGHT = 64;

interface Point {
  /** 收到的時間（瀏覽器時鐘），不用伺服器的 at，免得兩邊時鐘不準時曲線跑出畫面 */
  t: number;
  score: number | null;
}

type Level = keyof typeof MOTION_LEVEL_TEXT;
type FrameState = DetectFrameState | "connecting" | "lost";

const PROBES = ["line", "fill", "hot", "hotFill", "rule"] as const;
type Colors = Record<(typeof PROBES)[number], string>;

/**
 * 「畫面變化」：一條往左捲動的細曲線，一條固定的觸發線，越過時區塊轉成主色、右上角說「偵測到動作」。
 * 掛載時開一條 `/api/cameras/:id/motion`，卸載時關掉；pending 表示有沒儲存的靈敏度或遮罩（分數照已儲存的設定算）。
 */
export function ScoreMeter({ cameraId, minArea, pending }: { cameraId: string; minArea: number; pending: boolean }) {
  const [frame, setFrame] = useState<FrameState>("connecting");
  const [level, setLevel] = useState<Level>("calm");
  const canvas = useRef<HTMLCanvasElement>(null);
  const plot = useRef<HTMLDivElement>(null);
  const probes = useRef<HTMLSpanElement>(null);
  const minAreaRef = useRef(minArea);
  minAreaRef.current = minArea;
  const points = useRef<Point[]>([]);

  useEffect(() => {
    points.current = [];
    setFrame("connecting");
    const es = new EventSource(api.motionUrl(cameraId));
    es.addEventListener("sample", (ev) => {
      const s = JSON.parse((ev as MessageEvent<string>).data) as MotionSampleDto;
      const list = points.current;
      list.push({ t: performance.now(), score: s.state === "ok" ? s.score : null });
      const cut = performance.now() - WINDOW_MS - 1000;
      while (list.length && list[0]!.t < cut) list.shift();
      setFrame(s.state);
      setLevel(s.eventActive ? "event" : s.motion ? "motion" : "calm");
    });
    es.addEventListener("open", () => setFrame((f) => (f === "lost" ? "connecting" : f)));
    es.onerror = () => setFrame("lost");
    // 整頁離開時也關掉：每秒好幾筆的串流要是留在背景快取裡，會佔住瀏覽器對同一台主機的連線名額
    const onHide = () => es.close();
    addEventListener("pagehide", onHide);
    return () => {
      removeEventListener("pagehide", onHide);
      es.close();
    };
  }, [cameraId]);

  useEffect(() => {
    let colors: Colors | null = null;
    let colorsAt = 0;
    // canvas 讀不到 light-dark() 的值，用隱藏的點取得目前配色算好的顏色
    const readColors = (): Colors => {
      const now = performance.now();
      if (colors && now - colorsAt < 500) return colors;
      colorsAt = now;
      const els = [...(probes.current?.children ?? [])];
      colors = Object.fromEntries(PROBES.map((k, i) => [k, els[i] ? getComputedStyle(els[i]!).color : "currentColor"])) as Colors;
      return colors;
    };
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cv = canvas.current;
      const box = plot.current;
      if (!cv || !box || document.hidden) return;
      const dpr = devicePixelRatio || 1;
      const w = Math.round(box.clientWidth * dpr);
      const hgt = Math.round(HEIGHT * dpr);
      if (!w) return;
      if (cv.width !== w || cv.height !== hgt) {
        cv.width = w;
        cv.height = hgt;
      }
      const c = readColors();
      const g = cv.getContext("2d")!;
      g.clearRect(0, 0, w, hgt);
      const now = performance.now();
      const pad = 3 * dpr;
      const xOf = (t: number) => ((t - (now - WINDOW_MS)) / WINDOW_MS) * w;
      const yOf = (score: number) => hgt - pad - meterY(score, minAreaRef.current) * (hgt - 2 * pad);
      const lineY = hgt - pad - TRIGGER_Y * (hgt - 2 * pad);

      // 連續有分數的一段畫成一條；暖機、鏡頭移動中等沒有分數的地方留白
      const runs: Point[][] = [];
      let run: Point[] = [];
      for (const p of points.current) {
        if (p.score === null) {
          if (run.length) runs.push(run);
          run = [];
        } else run.push(p);
      }
      if (run.length) runs.push(run);

      for (const r of runs) {
        const path = new Path2D();
        r.forEach((p, i) => (i ? path.lineTo(xOf(p.t), yOf(p.score!)) : path.moveTo(xOf(p.t), yOf(p.score!))));
        const area = new Path2D(path);
        area.lineTo(xOf(r[r.length - 1]!.t), hgt);
        area.lineTo(xOf(r[0]!.t), hgt);
        area.closePath();
        g.fillStyle = c.fill;
        g.fill(area);
        // 觸發線以上的部分換成主色
        g.save();
        g.beginPath();
        g.rect(0, 0, w, lineY);
        g.clip();
        g.fillStyle = c.hotFill;
        g.fill(area);
        g.strokeStyle = c.hot;
        g.lineWidth = 2 * dpr;
        g.lineJoin = "round";
        g.stroke(path);
        g.restore();
        g.save();
        g.beginPath();
        g.rect(0, lineY, w, hgt - lineY);
        g.clip();
        g.strokeStyle = c.line;
        g.lineWidth = 1.5 * dpr;
        g.lineJoin = "round";
        g.stroke(path);
        g.restore();
      }

      g.strokeStyle = c.rule;
      g.lineWidth = 1 * dpr;
      g.setLineDash([4 * dpr, 4 * dpr]);
      g.beginPath();
      g.moveTo(0, Math.round(lineY) + 0.5);
      g.lineTo(w, Math.round(lineY) + 0.5);
      g.stroke();
      g.setLineDash([]);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const shown: Level = frame === "lost" ? "lost" : frame === "ok" ? level : "calm";
  const note = frame === "lost" ? MOTION_LEVEL_TEXT.lost : frame === "connecting" || frame === "ok" ? "" : DETECT_FRAME_TEXT[frame];
  return (
    <div className="meter" role="group" aria-label="即時畫面變化" data-level={shown}>
      <div className="meter-head">
        <span className="meter-title">畫面變化</span>
        <span className="meter-level" aria-live="polite">
          {frame === "ok" || frame === "lost" ? MOTION_LEVEL_TEXT[shown] : ""}
        </span>
      </div>
      <div ref={plot} className="meter-plot" style={{ "--trigger": `${(1 - TRIGGER_Y) * 100}%` } as CSSProperties}>
        <canvas ref={canvas} className="meter-canvas" height={HEIGHT} aria-hidden="true" />
        <span className="meter-trigger" aria-hidden="true" hidden={frame !== "ok"}>
          觸發線
        </span>
        <span className="meter-note" hidden={!note}>
          {note}
        </span>
      </div>
      <p className="meter-pending hint" hidden={!pending}>
        調整後的靈敏度與排除區域，儲存後才會反映在這裡。
      </p>
      <span ref={probes} className="meter-probes" aria-hidden="true">
        {PROBES.map((k) => (
          <i key={k} />
        ))}
      </span>
    </div>
  );
}
