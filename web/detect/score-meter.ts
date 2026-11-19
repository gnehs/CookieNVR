import type { DetectFrameState, MotionSampleDto } from "../../src/api-types.ts";
import { api } from "../api.ts";
import { h } from "../dom.ts";
import { DETECT_FRAME_TEXT, MOTION_LEVEL_TEXT } from "../health.ts";
import { meterY, TRIGGER_Y } from "./model.ts";

/** 曲線顯示最近這麼久 */
const WINDOW_MS = 30_000;
const HEIGHT = 64;

interface Point {
  /** 收到的時間（瀏覽器時鐘），不用伺服器的 at，免得兩邊時鐘不準時曲線跑出畫面 */
  t: number;
  score: number | null;
}

type Level = keyof typeof MOTION_LEVEL_TEXT;

export interface ScoreMeter {
  el: HTMLElement;
  /** 最小面積改了：觸發線不動，曲線依新的比例重畫 */
  setMinArea(minArea: number): void;
  /** 有沒儲存的靈敏度或遮罩：分數是照已儲存的設定算的，要講清楚 */
  setPending(pending: boolean): void;
  destroy(): void;
}

/** 「畫面變化」：一條往左捲動的細曲線，一條固定的觸發線，越過時區塊轉成主色、右上角說「偵測到動作」 */
export function scoreMeter(cameraId: string, initialMinArea: number): ScoreMeter {
  let minArea = initialMinArea;
  const points: Point[] = [];
  let frameState: DetectFrameState | "connecting" | "lost" = "connecting";
  let level: Level = "calm";

  const levelEl = h("span", { class: "meter-level", "aria-live": "polite" });
  const canvas = h("canvas", { class: "meter-canvas", height: String(HEIGHT), "aria-hidden": "true" });
  const note = h("span", { class: "meter-note" });
  const triggerTag = h("span", { class: "meter-trigger", "aria-hidden": "true" }, "觸發線");
  const pending = h("p", { class: "meter-pending hint", hidden: true }, "調整後的靈敏度與排除區域，儲存後才會反映在這裡。");
  // canvas 讀不到 light-dark() 的值，用這幾個隱藏的點取得目前配色算好的顏色
  const probes = { line: h("i"), fill: h("i"), hot: h("i"), hotFill: h("i"), rule: h("i") };
  const probeBox = h("span", { class: "meter-probes", "aria-hidden": "true" }, Object.values(probes));
  const plot = h("div", { class: "meter-plot" }, canvas, triggerTag, note);
  plot.style.setProperty("--trigger", `${(1 - TRIGGER_Y) * 100}%`);
  const el = h(
    "div",
    { class: "meter", role: "group", "aria-label": "即時畫面變化" },
    h("div", { class: "meter-head" }, h("span", { class: "meter-title" }, "畫面變化"), levelEl),
    plot,
    pending,
    probeBox,
  );
  el.dataset.level = level;

  const paintLabels = () => {
    const shown: Level = frameState === "lost" ? "lost" : frameState === "ok" ? level : "calm";
    levelEl.textContent = frameState === "ok" || frameState === "lost" ? MOTION_LEVEL_TEXT[shown] : "";
    el.dataset.level = shown;
    const text = frameState === "lost" ? MOTION_LEVEL_TEXT.lost : frameState === "connecting" || frameState === "ok" ? "" : DETECT_FRAME_TEXT[frameState];
    note.textContent = text;
    note.hidden = !text;
    triggerTag.hidden = frameState !== "ok";
  };
  paintLabels();

  const es = new EventSource(api.motionUrl(cameraId));
  es.addEventListener("sample", (ev) => {
    const s = JSON.parse((ev as MessageEvent<string>).data) as MotionSampleDto;
    points.push({ t: performance.now(), score: s.state === "ok" ? s.score : null });
    const cut = performance.now() - WINDOW_MS - 1000;
    while (points.length && points[0]!.t < cut) points.shift();
    const nextLevel: Level = s.eventActive ? "event" : s.motion ? "motion" : "calm";
    if (s.state !== frameState || nextLevel !== level) {
      frameState = s.state;
      level = nextLevel;
      paintLabels();
    }
  });
  es.addEventListener("open", () => {
    if (frameState === "lost") {
      frameState = "connecting";
      paintLabels();
    }
  });
  // 整頁離開時也關掉：每秒好幾筆的串流要是留在背景快取裡，會佔住瀏覽器對同一台主機的連線名額
  const onHide = () => es.close();
  addEventListener("pagehide", onHide);
  es.onerror = () => {
    frameState = "lost";
    paintLabels();
  };

  let colors: Record<keyof typeof probes, string> | null = null;
  let colorsAt = 0;
  const readColors = () => {
    const now = performance.now();
    if (colors && now - colorsAt < 500) return colors;
    colorsAt = now;
    colors = Object.fromEntries(Object.entries(probes).map(([k, p]) => [k, getComputedStyle(p).color])) as Record<keyof typeof probes, string>;
    return colors;
  };

  let raf = 0;
  const draw = () => {
    raf = requestAnimationFrame(draw);
    if (!el.isConnected || document.hidden) return;
    const dpr = devicePixelRatio || 1;
    const w = Math.round(plot.clientWidth * dpr);
    const hgt = Math.round(HEIGHT * dpr);
    if (!w) return;
    if (canvas.width !== w || canvas.height !== hgt) {
      canvas.width = w;
      canvas.height = hgt;
    }
    const c = readColors();
    const g = canvas.getContext("2d")!;
    g.clearRect(0, 0, w, hgt);
    const now = performance.now();
    const pad = 3 * dpr;
    const xOf = (t: number) => ((t - (now - WINDOW_MS)) / WINDOW_MS) * w;
    const yOf = (score: number) => hgt - pad - meterY(score, minArea) * (hgt - 2 * pad);
    const lineY = hgt - pad - TRIGGER_Y * (hgt - 2 * pad);

    // 連續有分數的一段畫成一條；暖機、鏡頭移動中等沒有分數的地方留白
    const runs: Point[][] = [];
    let run: Point[] = [];
    for (const p of points) {
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

  return {
    el,
    setMinArea(a) {
      minArea = a;
    },
    setPending(p) {
      pending.hidden = !p;
    },
    destroy() {
      cancelAnimationFrame(raf);
      removeEventListener("pagehide", onHide);
      es.close();
    },
  };
}
