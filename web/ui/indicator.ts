import { useLayoutEffect, useRef } from "react";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const boxOf = (el: HTMLElement): Box => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });

function apply(block: HTMLElement, b: Box) {
  block.style.setProperty("--x", `${b.x}px`);
  block.style.setProperty("--y", `${b.y}px`);
  block.style.setProperty("--w", `${b.w}px`);
  block.style.setProperty("--h", `${b.h}px`);
}

function snap(block: HTMLElement, b: Box) {
  block.dataset.instant = "";
  apply(block, b);
  void block.offsetWidth;
  block.dataset.shown = "";
  delete block.dataset.instant;
}

/**
 * 把底色方塊（.ind）移到 target 上。方塊原本藏著時直接落位、只淡入，不從舊位置滑過來；
 * target 是 null 就淡出。target 要以方塊的容器為 offsetParent（容器 position: relative）。
 */
export function moveIndicator(block: HTMLElement, target: HTMLElement | null, opts: { instant?: boolean; from?: Box } = {}) {
  if (!target) {
    delete block.dataset.shown;
    return;
  }
  const to = boxOf(target);
  if (opts.from) {
    snap(block, opts.from);
    apply(block, to);
  } else if (opts.instant || block.dataset.shown === undefined) snap(block, to);
  else apply(block, to);
}

// 換頁會整個重新掛載的導覽（例如設定分頁）靠這裡記住上一次的位置，新的一份從那裡滑過來
const remembered = new Map<string, Box>();

/**
 * 跟著容器裡符合 selector 的元素滑動的底色。key 變了（換頁、換選項）就重新對位；
 * 容器尺寸變了（側欄收合、視窗縮放）直接跟上，不播動畫。
 */
export function useIndicator<C extends HTMLElement>(selector: string, key: unknown, memory?: string) {
  const container = useRef<C>(null);
  const block = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const b = block.current;
    const target = container.current?.querySelector<HTMLElement>(selector) ?? null;
    if (!b) return;
    const from = memory && b.dataset.shown === undefined ? remembered.get(memory) : undefined;
    moveIndicator(b, target, { from });
    if (memory && target) remembered.set(memory, boxOf(target));
  }, [selector, key, memory]);
  useLayoutEffect(() => {
    const c = container.current;
    if (!c) return;
    // ResizeObserver 一開始觀察就會先回呼一次，那次不算尺寸改變，不然會把剛起跑的滑動直接對齊到終點
    let size = `${c.offsetWidth}x${c.offsetHeight}`;
    const ro = new ResizeObserver(() => {
      const now = `${c.offsetWidth}x${c.offsetHeight}`;
      if (now === size) return;
      size = now;
      const b = block.current;
      if (b?.dataset.shown !== undefined) moveIndicator(b, c.querySelector<HTMLElement>(selector), { instant: true });
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, [selector]);
  return { container, block };
}
