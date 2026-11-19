import type { BenchmarkDto, ObjectsDto } from "../../src/api-types.ts";
import { api } from "../api.ts";
import { benchmarkView, BENCHMARK_ASSUMPTION, BENCHMARK_RUNNING_NOTE, endedText, progressOf } from "../detect/benchmark-model.ts";
import { deviceLabel } from "../detect/object-model.ts";
import { errMsg, formatDateTime, h, icon, toast } from "../dom.ts";

export interface BenchmarkSection {
  el: HTMLElement;
  /** 用最新的 GET /api/objects 重畫；內容沒變的部分不動，輪詢不會洗掉焦點 */
  paint(data: ObjectsDto | null): void;
}

const toneIcon = (tone: "ok" | "warn" | "bad") => icon(tone === "ok" ? "check-circle" : "alert-circle", 18);

/** 「測速」：量這台機器大約能同時處理幾台攝影機。多個裝置時可以勾選要測哪些 */
export function benchmarkSection(onChange: () => void): BenchmarkSection {
  const selected = new Set<string>();
  let touched = false;
  let data: ObjectsDto | null = null;
  let starting = false;
  let pickKey = "";
  let resultKey = "";

  const pick = h("div", { class: "field", hidden: true });
  const startBtn = h("button", { class: "btn", type: "button" }, icon("activity", 16), "測速");
  const cancelBtn = h("button", { class: "btn", type: "button", hidden: true }, "取消");
  const startHint = h("small", { class: "hint", hidden: true });
  const actions = h("div", { class: "form-actions" }, startBtn, cancelBtn, startHint);
  const progressText = h("b", { class: "num" });
  const bar = h("i");
  const progress = h(
    "div",
    { class: "bench-progress", hidden: true, role: "status", "aria-live": "polite" },
    h("div", { class: "bench-progress-head" }, h("span", { class: "spin" }), progressText),
    h("div", { class: "bar", role: "progressbar", "aria-label": "測速進度", "aria-valuemin": "0", "aria-valuemax": "100" }, bar),
    h("small", { class: "hint" }, BENCHMARK_RUNNING_NOTE),
  );
  const result = h("div", { class: "bench-result", hidden: true });
  const el = h(
    "section",
    { class: "obj-bench", "aria-label": "測速" },
    h("div", { class: "obj-bench-head" }, h("span", { class: "legend" }, "測速"), h("small", { class: "hint" }, "測一下這台機器大約可以同時處理幾台攝影機。")),
    pick,
    actions,
    progress,
    result,
  );

  const running = () => data?.benchmark?.state === "running" || data?.status.paused === "benchmark";

  function paintPick() {
    const devices = data?.devices ?? [];
    const active = data?.status.device?.id ?? null;
    if (!touched) {
      selected.clear();
      const first = devices.find((d) => d.id === active) ?? devices[0];
      if (first) selected.add(first.id);
    }
    for (const id of [...selected]) if (!devices.some((d) => d.id === id)) selected.delete(id);
    const key = JSON.stringify([devices, active, running(), [...selected]]);
    pick.hidden = devices.length < 2 || running();
    if (key === pickKey) return;
    pickKey = key;
    const all = devices.length > 0 && devices.every((d) => selected.has(d.id));
    const allBtn = h("button", { class: "btn ghost small", type: "button" }, all ? "只測目前使用的" : "全部都測");
    allBtn.addEventListener("click", () => {
      touched = true;
      selected.clear();
      if (all) {
        const one = devices.find((d) => d.id === active) ?? devices[0];
        if (one) selected.add(one.id);
      } else for (const d of devices) selected.add(d.id);
      pickKey = "";
      paintPick();
      paintActions();
    });
    pick.replaceChildren(
      h("div", { class: "obj-bench-pickhead" }, h("span", { class: "legend" }, "要測哪些裝置"), allBtn),
      h(
        "div",
        { class: "obj-labels", role: "group", "aria-label": "要測哪些裝置" },
        devices.map((d) => {
          const input = h("input", { type: "checkbox", value: d.id, checked: selected.has(d.id) });
          input.addEventListener("change", () => {
            touched = true;
            if (input.checked) selected.add(d.id);
            else selected.delete(d.id);
            pickKey = "";
            paintPick();
            paintActions();
          });
          return h("label", { class: "obj-label" }, input, h("span", null, icon("check", 15), deviceLabel(d)));
        }),
      ),
    );
  }

  function paintActions() {
    const isRunning = running();
    startBtn.hidden = isRunning;
    cancelBtn.hidden = !isRunning;
    const ready = data?.status.state === "ready";
    const none = (data?.devices.length ?? 0) > 1 && selected.size === 0;
    startBtn.disabled = starting || !ready || none;
    startHint.hidden = isRunning || (ready && !none);
    startHint.textContent = !ready ? "物件辨識準備好之後才能測速。" : "請至少選一個裝置。";
  }

  function paintProgress() {
    const b = data?.benchmark;
    progress.hidden = !running();
    if (progress.hidden) return;
    const p = b && b.state === "running" ? progressOf(b, data!.devices) : { text: "準備中…", fraction: 0 };
    progressText.textContent = p.text;
    const pct = Math.round(p.fraction * 100);
    bar.style.width = `${pct}%`;
    bar.parentElement!.setAttribute("aria-valuenow", String(pct));
  }

  function paintResult() {
    const b = data?.benchmark ?? null;
    const show = !!b && b.state !== "running" && !running();
    result.hidden = !show;
    if (!show || !b) {
      resultKey = "";
      return;
    }
    const key = JSON.stringify([b, data!.status.device?.id, data!.models]);
    if (key === resultKey) return;
    resultKey = key;
    result.replaceChildren(...resultNodes(b, data!));
  }

  function paint(next: ObjectsDto | null) {
    if (!next) return;
    data = next;
    paintPick();
    paintActions();
    paintProgress();
    paintResult();
  }

  startBtn.addEventListener("click", async () => {
    starting = true;
    paintActions();
    try {
      const multi = (data?.devices.length ?? 0) > 1;
      data = { ...data!, benchmark: await api.startBenchmark(multi ? [...selected] : undefined) };
      onChange();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      starting = false;
      paint(data);
    }
  });
  cancelBtn.addEventListener("click", async () => {
    cancelBtn.disabled = true;
    try {
      await api.cancelBenchmark();
      onChange();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      cancelBtn.disabled = false;
    }
  });

  return { el, paint };
}

function resultNodes(b: BenchmarkDto, data: ObjectsDto): Node[] {
  const view = benchmarkView(b, { currentDevice: data.status.device?.id ?? null, models: data.models, formatTime: formatDateTime });
  const ended = endedText(b);
  const nodes: Node[] = [];
  if (ended) nodes.push(h("p", { class: `callout ${ended.tone}` }, icon("alert"), h("span", null, ended.text)));
  if (view.stale) nodes.push(h("p", { class: "callout warn" }, icon("alert"), h("span", null, "結果可能已過期（換了模型或裝置），建議重新測速。")));
  if (view.headline) nodes.push(h("p", { class: "bench-headline", "data-tone": view.headline.tone }, toneIcon(view.headline.tone), h("b", null, view.headline.text)));
  if (view.verdict) nodes.push(h("p", { class: "bench-verdict", "data-tone": view.verdict.tone }, view.verdict.text));
  if (view.rows.length > 1) {
    nodes.push(
      h(
        "ul",
        { class: "bench-rows", "aria-label": "各裝置的測速結果" },
        view.rows.map((r) =>
          h(
            "li",
            { "data-tone": r.tone },
            h("span", { class: "bench-name" }, r.name, r.current ? h("span", { class: "bench-tag" }, "使用中") : null, r.best ? h("span", { class: "bench-tag best" }, "最快") : null),
            h("span", { class: "bench-val num" }, r.text),
          ),
        ),
      ),
    );
  }
  const details = view.rows.filter((r) => r.detail);
  if (details.length) {
    nodes.push(
      h(
        "details",
        { class: "detect-more obj-details" },
        h("summary", null, icon("chevron", 15), "詳細數字"),
        h("dl", { class: "bench-detail" }, details.flatMap((r) => [h("dt", null, r.name), h("dd", { class: "num" }, r.detail)])),
      ),
    );
  }
  if (b.results.length > 0) {
    nodes.push(h("small", { class: "hint" }, view.meta), h("small", { class: "hint" }, BENCHMARK_ASSUMPTION));
  }
  return nodes;
}
