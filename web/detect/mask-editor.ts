import { LIMITS } from "../../src/detect/config.ts";
import type { MaskPolygon } from "../../src/types.ts";
import { h, icon } from "../dom.ts";
import { canAddMask, canClose, centroid, clamp01 } from "./model.ts";

type Pt = [number, number];

/**
 * idle：看遮罩，點一下某個遮罩選取它（拖頂點、刪除）；
 * drawing：每點一下加一個頂點，點回第一點或按「完成」收合。
 */
type Mode = { kind: "idle"; selected: number | null } | { kind: "drawing"; points: Pt[]; hover: Pt | null };

export interface MaskEditor {
  /** 快照加上遮罩的畫面 */
  stage: HTMLElement;
  /** 畫面下方的說明與按鈕 */
  toolbar: HTMLElement;
  value(): MaskPolygon[];
  /** 換上新的快照（blob: 網址換掉後會自動釋放）；null 是拿不到畫面，note 說明原因 */
  setImage(src: string | null, note?: string): void;
  /** 拆掉：釋放快照、移除鍵盤監聽 */
  destroy(): void;
}

/** 編輯器上的文字：動作偵測的排除區域和物件辨識的排除區域共用同一個編輯器 */
export interface MaskCopy {
  /** 畫面上每個區域的小標籤 */
  tag: string;
  /** 還沒有區域時的說明 */
  empty: string;
  /** 已有 n 個區域時的說明 */
  some: (n: number) => string;
  add: string;
}

export const MOTION_MASK_COPY: MaskCopy = {
  tag: "不偵測",
  empty: "畫出不需要偵測的範圍，例如馬路、搖動的樹或時間浮水印。",
  some: (n) => `${n} 個排除區域，裡面的變化不會觸發事件。點一下區域可以調整或刪除。`,
  add: "新增排除區域",
};

const SVG = "http://www.w3.org/2000/svg";
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

/** 手指或滑鼠移動超過這麼多 px 就不算點一下 */
const TAP_SLOP = 10;
let patternSeq = 0;

export function maskEditor(initial: MaskPolygon[], onChange: (masks: MaskPolygon[]) => void, copy: MaskCopy = MOTION_MASK_COPY): MaskEditor {
  const masks: Pt[][] = initial.map((m) => m.points.map(([x, y]) => [x, y] as Pt));
  let mode: Mode = { kind: "idle", selected: null };
  // 座標系跟著快照的實際長寬，斜線與線寬才不會被拉歪
  let W = 1600;
  let H = 900;

  const img = h("img", { class: "mask-img", alt: "", hidden: true, draggable: "false" });
  const placeholder = h("span", { class: "mask-ph" }, h("span", { class: "cam-ph" }, icon("camera", 24)), h("span", { class: "mask-ph-text" }));
  const pid = `mask-hatch-${++patternSeq}`;
  const overlay = svg("svg", { class: "mask-svg", preserveAspectRatio: "none", "aria-hidden": "true" });
  const handles = h("div", { class: "mask-handles" });
  const labels = h("div", { class: "mask-labels", "aria-hidden": "true" });
  const stage = h("div", { class: "mask-stage", "data-mode": "idle" }, placeholder, img, overlay, labels, handles);

  const hint = h("p", { class: "mask-hint hint", "aria-live": "polite" });
  const buttons = h("div", { class: "mask-actions" });
  const toolbar = h("div", { class: "mask-toolbar" }, hint, buttons);

  const commit = () => onChange(masks.map((points) => ({ points: points.map(([x, y]) => [round(x), round(y)] as Pt) })));
  const round = (v: number) => Math.round(v * 10_000) / 10_000;

  const toLocal = (e: { clientX: number; clientY: number }): Pt => {
    const r = stage.getBoundingClientRect();
    return [clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height)];
  };
  const pts = (list: Pt[]) => list.map(([x, y]) => `${x * W},${y * H}`).join(" ");

  function setMode(next: Mode) {
    mode = next;
    stage.dataset.mode = next.kind;
    render();
  }

  function finishDrawing() {
    if (mode.kind !== "drawing" || !canClose(mode.points)) return;
    masks.push(mode.points);
    commit();
    setMode({ kind: "idle", selected: null });
  }

  function addPoint(p: Pt) {
    if (mode.kind !== "drawing") return;
    mode.points.push(p);
    if (mode.points.length >= LIMITS.points.max) return finishDrawing();
    render();
  }

  // ---------- 畫面 ----------
  let polyEls: SVGPolygonElement[] = [];
  let handleEls: HTMLButtonElement[] = [];
  let labelEls: HTMLElement[] = [];
  let draft: { line: SVGPolylineElement; rubber: SVGLineElement; fill: SVGPolygonElement } | null = null;

  function defs() {
    const pattern = svg("pattern", { id: pid, patternUnits: "userSpaceOnUse", width: W / 70, height: W / 70, patternTransform: "rotate(45)" });
    pattern.append(svg("rect", { width: W / 70, height: W / 70, class: "mask-hatch-a" }), svg("rect", { width: W / 140, height: W / 70, class: "mask-hatch-b" }));
    const d = svg("defs");
    d.append(pattern);
    return d;
  }

  function render() {
    overlay.setAttribute("viewBox", `0 0 ${W} ${H}`);
    overlay.replaceChildren(defs());
    polyEls = masks.map((points, i) => {
      const selected = mode.kind === "idle" && mode.selected === i;
      const g = svg("g", { class: `mask${selected ? " selected" : ""}`, "data-index": i });
      const shade = svg("polygon", { class: "mask-fill", fill: `url(#${pid})` });
      const halo = svg("polygon", { class: "mask-halo", "vector-effect": "non-scaling-stroke" });
      const edge = svg("polygon", { class: "mask-edge", "vector-effect": "non-scaling-stroke" });
      g.append(shade, halo, edge);
      overlay.append(g);
      return edge;
    });
    draft = null;
    if (mode.kind === "drawing") {
      const fill = svg("polygon", { class: "mask-draft-fill", fill: `url(#${pid})` });
      const line = svg("polyline", { class: "mask-draft", "vector-effect": "non-scaling-stroke" });
      const rubber = svg("line", { class: "mask-rubber", "vector-effect": "non-scaling-stroke" });
      overlay.append(fill, line, rubber);
      draft = { line, rubber, fill };
    }

    labelEls = masks.map(() => h("span", { class: "mask-label" }, copy.tag));
    labels.replaceChildren(...labelEls);

    handleEls = [];
    if (mode.kind === "idle" && mode.selected !== null) {
      const i = mode.selected;
      handleEls = masks[i]!.map((_, j) => vertexHandle(i, j));
    } else if (mode.kind === "drawing") {
      handleEls = mode.points.map((_, j) => {
        const first = j === 0;
        const b = h("button", { type: "button", class: `mask-handle draft${first ? " first" : ""}`, tabindex: first ? "0" : "-1", "aria-label": first ? "回到第一點，完成這個區域" : `第 ${j + 1} 點` });
        if (first) {
          b.addEventListener("pointerdown", (e) => e.stopPropagation());
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            finishDrawing();
          });
        }
        return b;
      });
    }
    handles.replaceChildren(...handleEls);
    paint();
    renderToolbar();
  }

  /** 只更新位置，拖曳時元素不重建，指標捕捉才不會斷 */
  function paint() {
    masks.forEach((points, i) => {
      const g = polyEls[i]?.parentNode as SVGGElement | undefined;
      g?.querySelectorAll("polygon").forEach((p) => p.setAttribute("points", pts(points)));
      const [cx, cy] = centroid(points);
      const l = labelEls[i];
      if (l) {
        l.style.left = `${cx * 100}%`;
        l.style.top = `${cy * 100}%`;
        l.hidden = mode.kind === "idle" && mode.selected === i;
      }
    });
    const pointsShown = mode.kind === "idle" && mode.selected !== null ? masks[mode.selected]! : mode.kind === "drawing" ? mode.points : [];
    handleEls.forEach((b, j) => {
      const p = pointsShown[j];
      if (!p) return;
      b.style.left = `${p[0] * 100}%`;
      b.style.top = `${p[1] * 100}%`;
    });
    if (mode.kind === "drawing" && draft) {
      draft.line.setAttribute("points", pts(mode.points));
      draft.fill.setAttribute("points", pts(mode.points));
      const last = mode.points[mode.points.length - 1];
      const to = mode.hover;
      if (last && to) {
        draft.rubber.setAttribute("x1", String(last[0] * W));
        draft.rubber.setAttribute("y1", String(last[1] * H));
        draft.rubber.setAttribute("x2", String(to[0] * W));
        draft.rubber.setAttribute("y2", String(to[1] * H));
        draft.rubber.removeAttribute("hidden");
      } else draft.rubber.setAttribute("hidden", "");
      handleEls[0]?.toggleAttribute("data-ready", canClose(mode.points));
    }
  }

  function vertexHandle(i: number, j: number): HTMLButtonElement {
    const b = h("button", { type: "button", class: "mask-handle", "aria-label": `第 ${j + 1} 個頂點，用方向鍵移動` });
    let drag: { id: number } | null = null;
    b.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId };
      b.dataset.dragging = "";
    });
    b.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      masks[i]![j] = toLocal(e);
      paint();
    });
    const end = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      delete b.dataset.dragging;
      commit();
    };
    b.addEventListener("pointerup", end);
    b.addEventListener("pointercancel", end);
    b.addEventListener("click", (e) => e.stopPropagation());
    b.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 0.05 : 0.01;
      const d: Record<string, Pt> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const v = d[e.key];
      if (!v) return;
      e.preventDefault();
      const p = masks[i]![j]!;
      masks[i]![j] = [clamp01(p[0] + v[0]), clamp01(p[1] + v[1])];
      paint();
      commit();
    });
    return b;
  }

  function renderToolbar() {
    const btn = (label: string, iconName: string | null, onclick: () => void, cls = "btn small") =>
      h("button", { class: cls, type: "button", onclick }, iconName ? icon(iconName, 15) : null, label);
    if (mode.kind === "drawing") {
      const n = mode.points.length;
      hint.textContent = n === 0 ? "在畫面上點出要排除的範圍，一點一個角。" : canClose(mode.points) ? "點回第一點，或按「完成」收合。" : `再點 ${LIMITS.points.min - n} 個點以上就能收合。`;
      const done = btn("完成", "check", finishDrawing, "btn small primary");
      done.disabled = !canClose(mode.points);
      const undo = btn("復原", null, () => {
        if (mode.kind !== "drawing") return;
        mode.points.pop();
        render();
      });
      undo.disabled = n === 0;
      buttons.replaceChildren(btn("取消", null, () => setMode({ kind: "idle", selected: null }), "btn small ghost"), undo, done);
      return;
    }
    if (mode.selected !== null) {
      const i = mode.selected;
      hint.textContent = "拖曳圓點調整形狀。";
      buttons.replaceChildren(
        btn("刪除這個區域", "trash", () => {
          masks.splice(i, 1);
          commit();
          setMode({ kind: "idle", selected: null });
        }, "btn small danger"),
        btn("完成", "check", () => setMode({ kind: "idle", selected: null }), "btn small primary"),
      );
      return;
    }
    hint.textContent = masks.length ? copy.some(masks.length) : copy.empty;
    const add = btn(copy.add, "plus", () => setMode({ kind: "drawing", points: [], hover: null }));
    add.disabled = !canAddMask(masks);
    if (add.disabled) hint.textContent = `最多 ${LIMITS.masks} 個排除區域。`;
    buttons.replaceChildren(add);
  }

  // ---------- 畫面上的點選 ----------
  let tap: { id: number; x: number; y: number } | null = null;
  stage.addEventListener("pointerdown", (e) => {
    if (mode.kind !== "drawing" || !e.isPrimary || e.button > 0) return;
    tap = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  stage.addEventListener("pointermove", (e) => {
    if (mode.kind !== "drawing") return;
    if (tap && e.pointerId === tap.id && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP) tap = null;
    // 觸控沒有懸停，只有滑鼠畫預覽線
    if (e.pointerType === "mouse") {
      mode.hover = toLocal(e);
      paint();
    }
  });
  stage.addEventListener("pointerleave", () => {
    if (mode.kind !== "drawing") return;
    mode.hover = null;
    paint();
  });
  stage.addEventListener("pointerup", (e) => {
    if (mode.kind !== "drawing" || !tap || e.pointerId !== tap.id) return;
    tap = null;
    addPoint(toLocal(e));
  });
  stage.addEventListener("pointercancel", () => (tap = null));
  // 平常可以捲動頁面，所以選取遮罩用 click（捲動時不會觸發）
  stage.addEventListener("click", (e) => {
    if (mode.kind !== "idle") return;
    const g = (e.target as Element).closest?.("g.mask") as SVGGElement | null;
    const i = g ? Number(g.dataset.index) : null;
    setMode({ kind: "idle", selected: i === mode.selected ? null : i });
  });
  // 畫到一半或選取中按 Esc 只取消這一步：在 window 的捕獲階段先處理，外面的對話框收不到這次 Esc，不會整個關掉
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && (mode.kind === "drawing" || mode.selected !== null)) {
      e.preventDefault();
      e.stopPropagation();
      setMode({ kind: "idle", selected: null });
    } else if (e.key === "Enter" && mode.kind === "drawing" && e.target instanceof Node && (stage.contains(e.target) || toolbar.contains(e.target))) {
      e.preventDefault();
      finishDrawing();
    }
  };
  window.addEventListener("keydown", onKey, true);

  let shown: string | null = null;
  const swap = (src: string | null) => {
    if (shown?.startsWith("blob:") && shown !== src) URL.revokeObjectURL(shown);
    shown = src;
  };

  render();
  return {
    stage,
    toolbar,
    value: () => masks.map((points) => ({ points: points.map(([x, y]) => [round(x), round(y)] as Pt) })),
    destroy() {
      window.removeEventListener("keydown", onKey, true);
      swap(null);
      stage.remove();
      toolbar.remove();
    },
    setImage(src, note) {
      if (src === null) {
        swap(null);
        img.removeAttribute("src");
        img.hidden = true;
        placeholder.hidden = false;
        placeholder.querySelector(".mask-ph-text")!.textContent = note ?? "";
        return;
      }
      const probe = new Image();
      probe.onload = () => {
        if (probe.naturalWidth && (probe.naturalWidth !== W || probe.naturalHeight !== H)) {
          W = probe.naturalWidth;
          H = probe.naturalHeight;
          stage.style.aspectRatio = `${W} / ${H}`;
          render();
        }
        img.src = src;
        img.hidden = false;
        placeholder.hidden = true;
        swap(src);
      };
      probe.onerror = () => src.startsWith("blob:") && URL.revokeObjectURL(src);
      probe.src = src;
    },
  };
}
