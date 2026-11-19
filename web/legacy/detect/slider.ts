import { h } from "../dom.ts";

/** 0 到 100 的滑桿，填色跟著目前位置 */
export function slider(label: string, pos: number, onInput: (pos: number) => void) {
  const input = h("input", { type: "range", class: "range", min: "0", max: "100", step: "0.5", "aria-label": label });
  input.value = String(pos);
  const sync = () => input.style.setProperty("--fill", `${input.value}%`);
  input.addEventListener("input", () => {
    sync();
    onInput(Number(input.value));
  });
  sync();
  return input;
}
