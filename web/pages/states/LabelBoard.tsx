import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyHints } from "../../ui/Kbd.tsx";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { StateImageDto, StateSensorDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { errMsg } from "../../format.ts";
import { classIndexOfKey, jobActive } from "../../states/model.ts";
import { onSensorMessage, stateImagesQuery } from "../../states/queries.ts";
import { Button } from "../../ui/Button.tsx";
import { confirmDialog } from "../../ui/Dialog.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { toast } from "../../ui/toast.tsx";

/** 正在送出的變更：送出後先照它顯示，等伺服器的清單跟上再拿掉（null = 退回待標記，deleted = 刪除） */
type Override = { label: string | null } | { deleted: true };

const PENDING = "pending";

/** 伺服器清單已經反映這筆變更了嗎 */
function settled(o: Override, view: string, img: StateImageDto | undefined): boolean {
  if ("deleted" in o) return !img;
  const belongs = view === PENDING ? o.label === null : o.label === view;
  return belongs ? img?.label === o.label : !img;
}

const sourceText = (img: StateImageDto) => (img.source === "import" ? "Frigate 的判斷" : "上次的判斷");

/**
 * 標記畫面：分頁是「待標記」與每一類；網格裡每張圖下面是類別按鈕，按一下就標好。
 * 鍵盤：方向鍵移動、數字鍵標記（有選取時標記全部選取的）、Enter 採用預選、空白鍵選取、Delete 刪除、Esc 取消選取。
 */
export function LabelBoard({ sensor }: { sensor: StateSensorDto }) {
  const qc = useQueryClient();
  const classes = sensor.config.classes;
  const [view, setView] = useState<string>(sensor.images.pending > 0 || !sensor.model ? PENDING : classes[0]!);
  const activeView = view === PENDING || classes.includes(view) ? view : PENDING;
  const q = useQuery(stateImagesQuery(sensor.id, activeView));
  const [overrides, setOverrides] = useState<Map<string, Override>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const anchor = useRef<string | null>(null);

  // 伺服器的清單跟上之後，拿掉已經反映的變更
  const server = q.data;
  useEffect(() => {
    if (!server) return;
    setOverrides((prev) => {
      const byId = new Map(server.map((i) => [i.id, i]));
      const next = new Map([...prev].filter(([id, o]) => !settled(o, activeView, byId.get(id))));
      return next.size === prev.size ? prev : next;
    });
  }, [server, activeView]);

  const images = useMemo(() => {
    const list = (server ?? []).filter((img) => {
      const o = overrides.get(img.id);
      if (!o) return true;
      if ("deleted" in o) return false;
      return activeView === PENDING ? o.label === null : o.label === activeView;
    });
    return list.map((img) => {
      const o = overrides.get(img.id);
      return o && !("deleted" in o) ? { ...img, label: o.label } : img;
    });
  }, [server, overrides, activeView]);

  // 切換分頁時清掉選取
  useEffect(() => {
    setSelected(new Set());
    setFocusId(null);
  }, [activeView]);

  const ids = images.map((i) => i.id);
  const focusIndex = focusId ? ids.indexOf(focusId) : -1;
  const chosen = [...selected].filter((id) => ids.includes(id));
  const suggested = activeView === PENDING ? images.filter((i) => i.guess && classes.includes(i.guess.label)) : [];

  // 要移過去的焦點：等這次重畫完（被標走的那張已經拿掉）再移
  const focusNext = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = focusNext.current;
    if (!id) return;
    focusNext.current = null;
    grid.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.focus();
  });
  const focusTile = (id: string | null) => {
    focusNext.current = id;
    setFocusId(id);
  };

  /** 標記或刪除後焦點留在原本的位置（下一張遞補上來） */
  const afterRemoval = (removed: string[]) => {
    if (!focusId || !removed.includes(focusId)) return;
    const rest = ids.filter((id) => !removed.includes(id));
    const i = Math.min(Math.max(0, focusIndex - removed.filter((id) => ids.indexOf(id) < focusIndex).length), rest.length - 1);
    focusTile(rest[i] ?? null);
  };

  const apply = async (targets: string[], o: Override, run: () => Promise<StateSensorDto>) => {
    if (!targets.length) return;
    setOverrides((prev) => new Map([...prev, ...targets.map((id) => [id, o] as const)]));
    setSelected((prev) => new Set([...prev].filter((id) => !targets.includes(id))));
    const leaves = "deleted" in o || (activeView === PENDING ? o.label !== null : o.label !== activeView);
    if (leaves) afterRemoval(targets);
    try {
      onSensorMessage(qc, await run());
    } catch (e) {
      setOverrides((prev) => new Map([...prev].filter(([id]) => !targets.includes(id))));
      toast(errMsg(e), "error");
    }
  };

  const label = (targets: string[], to: string | null) => void apply(targets, { label: to }, () => api.labelStateImages(sensor.id, targets, to));

  const remove = async (targets: string[]) => {
    if (!targets.length) return;
    const ok = targets.length === 1 || (await confirmDialog(`刪除 ${targets.length} 張畫面？`, "刪除後就不會用來訓練，無法復原。", { confirmLabel: "刪除", danger: true }));
    if (ok) void apply(targets, { deleted: true }, () => api.deleteStateImages(sensor.id, targets));
  };

  const acceptSuggestions = () => {
    const groups = new Map<string, string[]>();
    for (const img of suggested) groups.set(img.guess!.label, [...(groups.get(img.guess!.label) ?? []), img.id]);
    for (const [to, list] of groups) label(list, to);
  };

  const toggle = (id: string, range = false) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (range && anchor.current && ids.includes(anchor.current)) {
        const [a, b] = [ids.indexOf(anchor.current), ids.indexOf(id)].sort((x, y) => x - y);
        for (const x of ids.slice(a!, b! + 1)) next.add(x);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchor.current = id;
  };

  const columns = () => {
    const el = grid.current;
    return el ? getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length : 1;
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>, img: StateImageDto) => {
    if (e.target !== e.currentTarget || e.altKey) return;
    const i = ids.indexOf(img.id);
    const move = (to: number) => {
      e.preventDefault();
      const id = ids[Math.min(ids.length - 1, Math.max(0, to))];
      if (id) focusTile(id);
    };
    if (e.metaKey || e.ctrlKey) {
      if (e.key === "a") {
        e.preventDefault();
        setSelected(new Set(ids));
      }
      return;
    }
    const k = classIndexOfKey(e.key, classes.length);
    if (k !== null) {
      e.preventDefault();
      label(chosen.length ? chosen : [img.id], classes[k]!);
      return;
    }
    switch (e.key) {
      case "ArrowRight":
        return move(i + 1);
      case "ArrowLeft":
        return move(i - 1);
      case "ArrowDown":
        return move(i + columns());
      case "ArrowUp":
        return move(i - columns());
      case "Home":
        return move(0);
      case "End":
        return move(ids.length - 1);
      case " ":
        e.preventDefault();
        return toggle(img.id, e.shiftKey);
      case "Enter":
        if (img.guess && classes.includes(img.guess.label) && img.label === null) {
          e.preventDefault();
          label([img.id], img.guess.label);
        }
        return;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        return void remove(chosen.length ? chosen : [img.id]);
      case "Escape":
        if (chosen.length) {
          e.preventDefault();
          setSelected(new Set());
        }
    }
  };

  const pendingCount = activeView === PENDING ? images.length : sensor.images.pending;
  const countOf = (c: string) => sensor.images.labeled.find((l) => l.label === c)?.count ?? 0;
  const busy = jobActive(sensor);
  // 2、3 類排一列；4 類 2×2；更多時每列 3 個
  const classCols = classes.length <= 3 ? classes.length : classes.length === 4 ? 2 : 3;
  const fine = typeof matchMedia !== "undefined" && matchMedia("(pointer: fine)").matches;

  return (
    <section className="card lb" aria-labelledby="lb-title">
      <header className="lb-head">
        <div>
          <h2 id="lb-title" className="card-title">
            標記畫面
          </h2>
          <p className="hint">每張畫面點一下它是哪一類。標得越多、越多種光線，判斷越準。</p>
        </div>
        <Button small icon="film" iconSize={15} disabled={busy} onClick={() => void api.collectStateImages(sensor.id).then((s) => onSensorMessage(qc, s)).catch((e) => toast(errMsg(e), "error"))}>
          從錄影再挑一些
        </Button>
      </header>
      <div className="lb-tabs" role="tablist" aria-label="畫面分類">
        <button type="button" role="tab" aria-selected={activeView === PENDING} onClick={() => setView(PENDING)}>
          待標記<span className="lb-count num">{pendingCount}</span>
        </button>
        {classes.map((c, i) => (
          <button key={c} type="button" role="tab" aria-selected={activeView === c} onClick={() => setView(c)}>
            <span className="lb-key num" aria-hidden="true">
              {i + 1 === 10 ? 0 : i + 1}
            </span>
            {c}
            <span className="lb-count num">{countOf(c)}</span>
          </button>
        ))}
      </div>

      {suggested.length > 0 ? (
        <div className="lb-suggest">
          <Icon name="info" size={16} />
          <span className="lb-suggest-text">{suggested.length} 張有預選的類別（虛線框），確認沒問題就一次標好。</span>
          <Button small onClick={acceptSuggestions}>
            全部照預選標記
          </Button>
        </div>
      ) : null}

      {q.isPending ? (
        <div className="lb-empty">
          <span className="spin" aria-hidden="true" /> 正在讀取畫面…
        </div>
      ) : q.isError ? (
        <div className="lb-empty">{errMsg(q.error)}</div>
      ) : images.length === 0 ? (
        <div className="lb-empty">
          {activeView === PENDING ? (
            <>
              <Icon name="check-circle" size={22} />
              <b>{busy ? "畫面準備好就會出現在這裡" : "都標記好了"}</b>
              {busy ? null : <span>辨識時遇到沒把握的畫面，也會自動放進這裡。</span>}
            </>
          ) : (
            <span>還沒有標記成「{activeView}」的畫面。</span>
          )}
        </div>
      ) : (
        <div ref={grid} className="lb-grid" data-many={classes.length > 2 ? "" : undefined} role="listbox" aria-multiselectable="true" aria-label={activeView === PENDING ? "待標記的畫面" : `標記為「${activeView}」的畫面`}>
          {images.map((img, i) => {
            const isSel = selected.has(img.id);
            const guess = img.guess && classes.includes(img.guess.label) ? img.guess : null;
            return (
              <div
                key={img.id}
                data-id={img.id}
                className="lb-tile"
                role="option"
                aria-selected={isSel}
                aria-label={`第 ${i + 1} 張${img.label ? `，${img.label}` : guess ? `，預選「${guess.label}」` : ""}`}
                tabIndex={focusId ? (img.id === focusId ? 0 : -1) : i === 0 ? 0 : -1}
                onFocus={(e) => e.target === e.currentTarget && setFocusId(img.id)}
                onKeyDown={(e) => onKey(e, img)}
              >
                <div className="lb-shot" onClick={(e) => toggle(img.id, e.shiftKey)}>
                  <img src={img.url} alt="" loading="lazy" decoding="async" draggable={false} />
                  <span className="lb-check" aria-hidden="true">
                    {isSel ? <Icon name="check" size={14} /> : null}
                  </span>
                  {guess && img.label === null ? (
                    <span className="lb-guess" title={`${sourceText(img)}：${guess.label}（${Math.round(guess.score * 100)}%）`}>
                      {sourceText(img)}：{guess.label}
                    </span>
                  ) : null}
                </div>
                <div className="lb-classes" style={{ "--cols": classCols } as CSSProperties}>
                  {classes.map((c, k) => (
                    <button
                      key={c}
                      type="button"
                      tabIndex={-1}
                      className="lb-cls"
                      aria-pressed={img.label === c}
                      data-suggested={img.label === null && guess?.label === c ? "" : undefined}
                      onClick={() => (img.label === c ? undefined : label([img.id], c))}
                    >
                      {fine && k < 10 ? <kbd className="num">{k + 1 === 10 ? 0 : k + 1}</kbd> : null}
                      <span>{c}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {fine && images.length > 0 ? (
        <KeyHints
          className="lb-keys"
          always
          hints={[
            { keys: ["←", "→"], label: "移動" },
            { keys: classes.length <= 3 ? classes.map((_, i) => String(i + 1)) : ["1", "…", String(Math.min(classes.length, 10) % 10)], label: "標記" },
            { keys: ["Enter"], label: "採用預選" },
            { keys: ["空白鍵"], label: "選取" },
            { keys: ["Delete"], label: "刪除" },
          ]}
        />
      ) : null}

      {chosen.length > 0 ? (
        <div className="lb-bar" role="toolbar" aria-label={`已選取 ${chosen.length} 張`}>
          <b className="num">已選 {chosen.length} 張</b>
          <span className="lb-bar-label">標成</span>
          {classes.map((c) => (
            <Button key={c} small onClick={() => label(chosen, c)} disabled={activeView === c}>
              {c}
            </Button>
          ))}
          {activeView !== PENDING ? (
            <Button small variant="ghost" onClick={() => label(chosen, null)}>
              移回待標記
            </Button>
          ) : null}
          <span className="lb-bar-gap" />
          <Button small variant="danger" icon="trash" iconSize={15} onClick={() => void remove(chosen)}>
            刪除
          </Button>
          <Button small variant="ghost" onClick={() => setSelected(new Set())}>
            取消
          </Button>
        </div>
      ) : null}
    </section>
  );
}
