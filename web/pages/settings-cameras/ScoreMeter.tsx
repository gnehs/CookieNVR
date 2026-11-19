import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { DetectFrameState, MotionSampleDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { meterY, scoreAtThreshold, TRIGGER_Y } from "../../detect/model.ts";
import { DETECT_FRAME_TEXT, MOTION_LEVEL_TEXT } from "../../health.ts";

/** 曲線顯示最近這麼久 */
const WINDOW_MS = 30_000;
const HEIGHT = 64;

interface Point {
  /** 收到的時間（瀏覽器時鐘），不用伺服器的 at，免得兩邊時鐘不準時曲線跑出畫面 */
  t: number;
  score: number | null;
  /** 各靈敏度下的分數；有它時依目前滑桿的值換算，還沒儲存的靈敏度也能即時預覽 */
  curve?: number[];
}

/** 這一點在目前（可能還沒儲存）的像素門檻下的分數 */
const scoreOf = (p: Point, threshold: number) => (p.score === null ? null : p.curve ? scoreAtThreshold(p.curve, threshold) : p.score);

type Level = keyof typeof MOTION_LEVEL_TEXT;
type FrameState = DetectFrameState | "connecting" | "lost";

const PROBES = ["line", "fill", "hot", "hotFill", "rule"] as const;
type Colors = Record<(typeof PROBES)[number], string>;

/**
 * 「畫面變化」：一條往左捲動的細曲線，一條固定的觸發線，越過時區塊轉成主色、右上角說「偵測到動作」。
 * 掛載時開一條 `/api/cameras/:id/motion`，卸載時關掉。靈敏度與最小面積用表單上目前的值即時換算；
 * 排除區域要儲存後 worker 才會套用，masksPending 時提示。
 */
export function ScoreMeter({ cameraId, minArea, threshold, thresholdPending, masksPending }: { cameraId: string; minArea: number; threshold: number; thresholdPending: boolean; masksPending: boolean }) {
  const [frame, setFrame] = useState<FrameState>("connecting");
  const [level, setLevel] = useState<Level>("calm");
  const canvas = useRef<HTMLCanvasElement>(null);
  const plot = useRef<HTMLDivElement>(null);
  const probes = useRef<HTMLSpanElement>(null);
  const minAreaRef = useRef(minArea);
  minAreaRef.current = minArea;
  const thresholdRef = useRef(threshold);
  thresholdRef.current = threshold;
  /** 舊版後端不送預覽分數；那時靈敏度仍要儲存後才看得到 */
  const [hasCurve, setHasCurve] = useState(false);
  const last = useRef<{ point: Point; motion: boolean; eventActive: boolean } | null>(null);
  const points = useRef<Point[]>([]);

  useEffect(() => {
    points.current = [];
    setFrame("connecting");
    const es = new EventSource(api.motionUrl(cameraId));
    es.addEventListener("sample", (ev) => {
      const s = JSON.parse((ev as MessageEvent<string>).data) as MotionSampleDto;
      const list = points.current;
      const point: Point = { t: performance.now(), score: s.state === "ok" ? s.score : null, ...(s.curve ? { curve: s.curve } : {}) };
      list.push(point);
      const cut = performance.now() - WINDOW_MS - 1000;
      while (list.length && list[0]!.t < cut) list.shift();
      if (s.curve) setHasCurve(true);
      last.current = { point, motion: s.motion, eventActive: s.eventActive };
      setFrame(s.state);
      setLevel(levelOf(last.current, thresholdRef.current, minAreaRef.current));
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
      const th = thresholdRef.current;
      const yOf = (p: Point) => hgt - pad - meterY(scoreOf(p, th)!, minAreaRef.current) * (hgt - 2 * pad);
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
        r.forEach((p, i) => (i ? path.lineTo(xOf(p.t), yOf(p)) : path.moveTo(xOf(p.t), yOf(p))));
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

  // 拖滑桿時不等下一張畫面，用最後一筆重新判斷「偵測到動作」
  useEffect(() => {
    if (last.current) setLevel(levelOf(last.current, threshold, minArea));
  }, [threshold, minArea]);

  const shown: Level = frame === "lost" ? "lost" : frame === "ok" ? level : "calm";
  const pendingText = masksPending
    ? thresholdPending && !hasCurve
      ? "調整後的靈敏度與排除區域，儲存後才會反映在這裡。"
      : "調整後的排除區域，儲存後才會反映在這裡。"
    : thresholdPending && !hasCurve
      ? "調整後的靈敏度，儲存後才會反映在這裡。"
      : "";
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
      <p className="meter-pending hint" hidden={!pendingText}>
        {pendingText}
      </p>
      <span ref={probes} className="meter-probes" aria-hidden="true">
        {PROBES.map((k) => (
          <i key={k} />
        ))}
      </span>
    </div>
  );
}

/** 進行中的事件以後端為準；有預覽分數時「偵測到動作」用目前的靈敏度與最小面積判斷，沒有就用後端的判斷 */
function levelOf(l: { point: Point; motion: boolean; eventActive: boolean }, threshold: number, minArea: number): Level {
  if (l.eventActive) return "event";
  const score = scoreOf(l.point, threshold);
  const motion = l.point.curve && score !== null ? score > minArea : l.motion;
  return motion ? "motion" : "calm";
}
