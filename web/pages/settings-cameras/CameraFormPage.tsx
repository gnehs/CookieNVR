import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CameraDto, ProbeResult } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { camerasQuery, systemQuery } from "../../data/queries.ts";
import { infoQuery } from "../../data/session.ts";
import { errMsg } from "../../format.ts";
import { ButtonLink, CopyButton } from "../../ui/Button.tsx";
import { confirmDialog } from "../../ui/Dialog.tsx";
import { FormCard } from "../../ui/FormCard.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { BrandMark } from "../../ui/Panel.tsx";
import { ErrorBox, PageError, Spinner } from "../../ui/states.tsx";
import { SettingsSubpage } from "../settings/SettingsLayout.tsx";
import { CameraEditPage } from "./CameraEditPage.tsx";
import { putCamera } from "./cache.ts";
import { BasicFields, ConnFields, RecFields, useFocusError } from "./fields.tsx";
import { basicSummary, clearsError, connSummary, draftOf, errorCard, probeFailure, recSummary, streamLine, validate, type Draft, type FormError } from "./form-model.ts";
import { PtzSupportNote } from "./PtzPrefs.tsx";

export type CameraFormMode = "welcome" | "new" | "edit";

type Probed = Extract<ProbeResult, { ok: true }>;

/** 送出的進度：測試連線、儲存，成功後換成結果頁 */
type Phase = { kind: "editing" } | { kind: "testing" } | { kind: "saving" } | { kind: "done"; cam: CameraDto; probe: Probed };

function SuccessView({ cam, probe, onAgain }: { cam: CameraDto; probe: Probed; onAgain: () => void }) {
  const c = cam.config;
  const title = useRef<HTMLHeadingElement>(null);
  // 送出按鈕已經不在畫面上，焦點移到結果標題，螢幕閱讀器會念出「已加入」
  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, []);
  return (
    <div className="success-page">
      <div className="card success">
        <div className="success-shot">
          {probe.snapshotJpegBase64 ? (
            <img alt={`${c.name} 的畫面`} src={`data:image/jpeg;base64,${probe.snapshotJpegBase64}`} width={640} height={360} />
          ) : (
            <span className="cam-ph">
              <Icon name="camera" size={28} />
            </span>
          )}
        </div>
        <div className="success-body">
          <h1 ref={title} tabIndex={-1}>
            已加入「{c.name}」
          </h1>
          <p className="success-lead">
            <Icon name="check-circle" size={18} />
            {c.enabled && c.record.enabled ? "已開始錄影" : "連線成功"}
          </p>
          <PtzSupportNote onvif={probe.onvif} />
          <details className="spec-details">
            <summary>詳細資訊</summary>
            <dl className="spec">
              <dt>高畫質</dt>
              <dd>{streamLine(probe.main)}</dd>
              <dt>低畫質</dt>
              <dd>{probe.sub ? streamLine(probe.sub) : "沒有，預覽會改用高畫質縮小"}</dd>
            </dl>
          </details>
          <div className="success-actions">
            <ButtonLink to="/cameras" variant="primary">
              完成
            </ButtonLink>
            <Link className="text-link" to="/settings/cameras/new" onClick={onAgain}>
              再加一台
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 新增攝影機（含首次使用的 /welcome）：基本、連線、錄影一次填完，測試連線成功才儲存 */
function NewCameraForm({ welcome, onAgain }: { welcome: boolean; onAgain: () => void }) {
  const qc = useQueryClient();
  const listHref = welcome ? "/cameras" : "/settings/cameras";
  const siteName = useQuery(infoQuery).data?.siteName ?? "CookieNVR";

  const [saved] = useState(() => draftOf(null));
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<FormError | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });

  const form = useRef<HTMLFormElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const busy = phase.kind === "testing" || phase.kind === "saving";
  const badCard = errorCard(error);
  useFocusError(form, error);

  // 離開前提醒：有改過、而且還沒存好
  const unsaved = phase.kind !== "done" && JSON.stringify(draft) !== JSON.stringify(saved);
  const unsavedRef = useRef(unsaved);
  unsavedRef.current = unsaved;
  useBlocker({
    shouldBlockFn: async () => {
      if (!unsavedRef.current) return false;
      return !(await confirmDialog("要離開這一頁嗎？", "還沒儲存的變更會不見。", { confirmLabel: "離開", danger: true }));
    },
    enableBeforeUnload: () => unsavedRef.current,
  });

  useEffect(() => {
    if (matchMedia("(pointer: fine)").matches) nameInput.current?.focus();
  }, []);

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    if (clearsError(error, patch)) setError(null);
  };
  const kit = { draft, set, error };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const r = validate(draft, null, undefined);
    if ("error" in r) return setError(r.error);
    setPhase({ kind: "testing" });
    try {
      const probe = await api.testCamera(r.conn);
      if (!probe.ok) return setError(probeFailure(r.conn, probe.error, probe.detail));
      setPhase({ kind: "saving" });
      const cam = await api.createCamera(r.config);
      putCamera(qc, cam);
      void qc.invalidateQueries({ queryKey: systemQuery.queryKey });
      setPhase({ kind: "done", cam, probe });
    } catch (err) {
      setError({ summary: errMsg(err) });
    } finally {
      setPhase((p) => (p.kind === "done" ? p : { kind: "editing" }));
    }
  };

  if (phase.kind === "done") return <SuccessView cam={phase.cam} probe={phase.probe} onAgain={onAgain} />;

  const body = (
    <form ref={form} className="cam-form" noValidate onSubmit={submit}>
      <div className="fcards">
        <FormCard title="基本" icon="edit" defaultOpen summary={basicSummary(draft, false)} error={badCard === "basic"}>
          <BasicFields kit={kit} existing={false} nameRef={nameInput} />
        </FormCard>
        <FormCard title="連線" icon="link" defaultOpen summary={connSummary(draft)} error={badCard === "conn"}>
          <ConnFields kit={kit} existing={null} />
        </FormCard>
        <FormCard title="錄影" icon="rec" summary={recSummary(draft)} error={badCard === "rec"}>
          <RecFields kit={kit} />
        </FormCard>
      </div>
      <div className="form-bar">
        <div className="foot-status">
          <p className="form-error" role="alert">
            {error?.summary}
          </p>
          <span className="copy-slot">{error?.copy ? <CopyButton label="複製錯誤內容" className="small ghost" done="已複製錯誤內容，可以貼給 AI 或技術人員" getText={() => error.copy!} /> : null}</span>
        </div>
        <Link className="btn" to={listHref}>
          {welcome ? "稍後再說" : "取消"}
        </Link>
        <button className="btn primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
          {busy ? (
            <>
              <span className="spin" aria-hidden="true" />
              <span>{phase.kind === "testing" ? "正在測試連線…" : "儲存中…"}</span>
            </>
          ) : (
            <span>測試並儲存</span>
          )}
        </button>
      </div>
    </form>
  );

  if (welcome) {
    return (
      <main className="onboard">
        <div className="onboard-brand">
          <BrandMark />
          <span>{siteName}</span>
        </div>
        <header className="onboard-head">
          <h1>加入第一台攝影機</h1>
          <p>填好後按「測試並儲存」，連線成功就會直接儲存，並馬上開始錄影。</p>
        </header>
        {body}
      </main>
    );
  }
  return (
    <SettingsSubpage title="新增攝影機" back={listHref}>
      {body}
    </SettingsSubpage>
  );
}

/**
 * 新增（含首次使用的 /welcome）與編輯攝影機。編輯時從攝影機快取找這台，交給 CameraEditPage；
 * 各區塊的對話框只在打開時取一次設定，之後 SSE 推來的狀態更新不會蓋掉正在編輯的值。
 */
export function CameraFormPage({ id, mode }: { id: string | null; mode: CameraFormMode }) {
  const cams = useQuery({ ...camerasQuery, enabled: id !== null });
  const [round, setRound] = useState(0);
  // 刪除後快取裡已經沒有這台，但還沒換頁；別閃一下「找不到」
  const last = useRef<CameraDto | null>(null);
  if (id === null) return <NewCameraForm key={`new-${round}`} welcome={mode === "welcome"} onAgain={() => setRound((n) => n + 1)} />;
  if (cams.isPending) return <Spinner />;
  if (cams.isError) return <ErrorBox error={cams.error} onRetry={() => void cams.refetch()} />;
  const cam = cams.data.find((c) => c.id === id) ?? (last.current?.id === id ? last.current : null);
  if (!cam) return <ErrorBox error={new PageError("找不到這台攝影機", "它可能已經被刪除了。", { label: "回到攝影機列表", to: "/settings/cameras" })} />;
  last.current = cam;
  return <CameraEditPage key={id} camera={cam} />;
}
