import { plural, t as tc } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyHints } from "../../ui/Kbd.tsx";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { STATE_UNSURE_BELOW, type StateImageDto, type StateSensorDto } from "../../../src/api-types.ts";
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

function tileLabel(n: number, label: string | null, guess: string | null): string {
  if (label) return tc`Picture ${n}, ${label}`;
  if (guess) return tc`Picture ${n}, suggested “${guess}”`;
  return tc`Picture ${n}`;
}

const guessText = (source: string, label: string) => tc`${source}: ${label}`;
const guessTitle = (source: string, label: string, percent: number) => tc`${source}: ${label} (${percent}%)`;

/** 判斷的信心夠高：標了也學不到新東西，待標記裡先收起來 */
const isSure = (img: StateImageDto, classes: readonly string[]) => !!img.guess && classes.includes(img.guess.label) && img.guess.score >= STATE_UNSURE_BELOW;

const sourceText = (img: StateImageDto) => (img.source === "import" ? tc`Frigate’s guess` : tc`Last guess`);

/**
 * 標記畫面：分頁是「待標記」與每一類；網格裡每張圖下面是類別按鈕，按一下就標好。
 * 待標記只先列出判斷沒把握的圖；有把握的收起來，可以展開檢查或一次照建議標好。
 * 鍵盤：方向鍵移動、數字鍵標記（有選取時標記全部選取的）、Enter 採用預選、空白鍵選取、Delete 刪除、Esc 取消選取。
 */
export function LabelBoard({ sensor }: { sensor: StateSensorDto }) {
  const { t } = useLingui();
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
  const [showSure, setShowSure] = useState(false);

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

  const all = useMemo(() => {
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

  const sure = useMemo(() => (activeView === PENDING ? all.filter((img) => isSure(img, classes)) : []), [all, activeView, classes]);
  const images = useMemo(() => {
    if (!sure.length) return all;
    const unsure = all.filter((img) => !sure.includes(img));
    return showSure ? [...unsure, ...sure] : unsure;
  }, [all, sure, showSure]);

  // 切換分頁時清掉選取
  useEffect(() => {
    setSelected(new Set());
    setFocusId(null);
  }, [activeView]);

  const ids = images.map((i) => i.id);
  const focusIndex = focusId ? ids.indexOf(focusId) : -1;
  const chosen = [...selected].filter((id) => ids.includes(id));

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
    const count = targets.length;
    const ok = count === 1 || (await confirmDialog(plural(count, { one: "Delete # picture?", other: "Delete # pictures?" }), t`Deleted pictures won’t be used for training. This can’t be undone.`, { confirmLabel: t`Delete`, danger: true }));
    if (ok) void apply(targets, { deleted: true }, () => api.deleteStateImages(sensor.id, targets));
  };

  const acceptSure = () => {
    const groups = new Map<string, string[]>();
    for (const img of sure) groups.set(img.guess!.label, [...(groups.get(img.guess!.label) ?? []), img.id]);
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

  const pendingCount = activeView === PENDING ? all.length : sensor.images.pending;
  const countOf = (c: string) => sensor.images.labeled.find((l) => l.label === c)?.count ?? 0;
  const busy = jobActive(sensor);
  const chosenCount = chosen.length;
  const sureCount = sure.length;
  // 2、3 類排一列；4 類 2×2；更多時每列 3 個
  const classCols = classes.length <= 3 ? classes.length : classes.length === 4 ? 2 : 3;
  const fine = typeof matchMedia !== "undefined" && matchMedia("(pointer: fine)").matches;

  return (
    <section className="card lb" aria-labelledby="lb-title">
      <header className="lb-head">
        <div>
          <h2 id="lb-title" className="card-title">
            <Trans>Label pictures</Trans>
          </h2>
          <p className="hint">
            <Trans>Click which class each picture belongs to. The more you label, and under more kinds of light, the more accurate detection gets.</Trans>
          </p>
        </div>
        <Button small icon="film" iconSize={15} disabled={busy} onClick={() => void api.collectStateImages(sensor.id).then((s) => onSensorMessage(qc, s)).catch((e) => toast(errMsg(e), "error"))}>
          <Trans>Pick more from recordings</Trans>
        </Button>
      </header>
      <div className="lb-tabs scroll-fade-x" role="tablist" aria-label={t`Picture categories`}>
        <button type="button" role="tab" aria-selected={activeView === PENDING} onClick={() => setView(PENDING)}>
          <Trans>Unlabeled</Trans>
          <span className="lb-count num">{pendingCount}</span>
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

      {sure.length > 0 ? (
        <div className="lb-suggest">
          <Icon name="info" size={16} />
          <span className="lb-suggest-text">
            {showSure ? (
              <Plural value={sureCount} one="The last # picture is one detection is already sure about. If its suggestion looks right, label it in one go." other="The last # pictures are ones detection is already sure about. If the suggestions look right, label them all in one go." />
            ) : (
              <Plural value={sureCount} one="# picture detection is already sure about is hidden, so you only need to label the ones it isn’t sure about." other="# pictures detection is already sure about are hidden, so you only need to label the ones it isn’t sure about." />
            )}
          </span>
          <Button small variant="ghost" onClick={() => setShowSure((v) => !v)}>
            {showSure ? <Trans>Hide</Trans> : <Trans>Show</Trans>}
          </Button>
          <Button small onClick={acceptSure}>
            <Trans>Label all as suggested</Trans>
          </Button>
        </div>
      ) : null}

      {q.isPending ? (
        <div className="lb-empty">
          <span className="spin" aria-hidden="true" /> <Trans>Loading pictures…</Trans>
        </div>
      ) : q.isError ? (
        <div className="lb-empty">{errMsg(q.error)}</div>
      ) : images.length === 0 ? (
        <div className="lb-empty">
          {activeView === PENDING ? (
            <>
              <Icon name="check-circle" size={22} />
              <b>{busy ? t`Pictures will show up here when they’re ready` : sure.length ? t`Nothing left that detection isn’t sure about` : t`All labeled`}</b>
              {busy ? null : <span>{t`Pictures detection isn’t sure about are added here automatically.`}</span>}
            </>
          ) : (
            <span>{t`No pictures labeled “${activeView}” yet.`}</span>
          )}
        </div>
      ) : (
        <div ref={grid} className="lb-grid" data-many={classes.length > 2 ? "" : undefined} role="listbox" aria-multiselectable="true" aria-label={activeView === PENDING ? t`Unlabeled pictures` : t`Pictures labeled “${activeView}”`}>
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
                aria-label={tileLabel(i + 1, img.label, guess?.label ?? null)}
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
                    <span className="lb-guess" title={guessTitle(sourceText(img), guess.label, Math.round(guess.score * 100))}>
                      {guessText(sourceText(img), guess.label)}
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
            { keys: ["←", "→"], label: t`Move` },
            { keys: classes.length <= 3 ? classes.map((_, i) => String(i + 1)) : ["1", "…", String(Math.min(classes.length, 10) % 10)], label: t`Label` },
            { keys: ["Enter"], label: t`Accept suggestion` },
            { keys: ["Space"], label: t`Select` },
            { keys: ["Delete"], label: t`Delete` },
          ]}
        />
      ) : null}

      {chosen.length > 0 ? (
        <div className="lb-bar" role="toolbar" aria-label={t`${chosenCount} selected`}>
          <b className="num">{t`${chosenCount} selected`}</b>
          <span className="lb-bar-label">{t`Mark as`}</span>
          {classes.map((c) => (
            <Button key={c} small onClick={() => label(chosen, c)} disabled={activeView === c}>
              {c}
            </Button>
          ))}
          {activeView !== PENDING ? (
            <Button small variant="ghost" onClick={() => label(chosen, null)}>
              <Trans>Move back to unlabeled</Trans>
            </Button>
          ) : null}
          <span className="lb-bar-gap" />
          <Button small variant="danger" icon="trash" iconSize={15} onClick={() => void remove(chosen)}>
            <Trans>Delete</Trans>
          </Button>
          <Button small variant="ghost" onClick={() => setSelected(new Set())}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      ) : null}
    </section>
  );
}
