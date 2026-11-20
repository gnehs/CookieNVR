import { useLingui } from "@lingui/react/macro";
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
  const { t } = useLingui();
  const c = cam.config;
  const name = c.name;
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
            <img alt={t`Picture from ${name}`} src={`data:image/jpeg;base64,${probe.snapshotJpegBase64}`} width={640} height={360} />
          ) : (
            <span className="cam-ph">
              <Icon name="camera" size={28} />
            </span>
          )}
        </div>
        <div className="success-body">
          <h1 ref={title} tabIndex={-1}>
            {t`Added "${name}"`}
          </h1>
          <p className="success-lead">
            <Icon name="check-circle" size={18} />
            {c.enabled && c.record.enabled ? t`Recording started` : t`Connected`}
          </p>
          <PtzSupportNote onvif={probe.onvif} />
          <details className="spec-details">
            <summary>{t`Details`}</summary>
            <dl className="spec">
              <dt>{t`High quality`}</dt>
              <dd>{streamLine(probe.main)}</dd>
              <dt>{t`Low quality`}</dt>
              <dd>{probe.sub ? streamLine(probe.sub) : t`None. Previews use the high-quality stream, scaled down.`}</dd>
            </dl>
          </details>
          <div className="success-actions">
            <ButtonLink to="/cameras" variant="primary">
              {t`Done`}
            </ButtonLink>
            <Link className="text-link" to="/settings/cameras/new" onClick={onAgain}>
              {t`Add another camera`}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 新增攝影機（含首次使用的 /welcome）：基本、連線、錄影一次填完，測試連線成功才儲存 */
function NewCameraForm({ welcome, onAgain }: { welcome: boolean; onAgain: () => void }) {
  const { t } = useLingui();
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
      return !(await confirmDialog(t`Leave this page?`, t`Unsaved changes will be lost.`, { confirmLabel: t`Leave`, danger: true }));
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
      if (!probe.ok) return setError(probeFailure(r.conn, probe));
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
        <FormCard title={t`Basic`} icon="edit" defaultOpen summary={basicSummary(draft, false)} error={badCard === "basic"}>
          <BasicFields kit={kit} existing={false} nameRef={nameInput} />
        </FormCard>
        <FormCard title={t`Connection`} icon="link" defaultOpen summary={connSummary(draft)} error={badCard === "conn"}>
          <ConnFields kit={kit} existing={null} />
        </FormCard>
        <FormCard title={t`Recording`} icon="rec" summary={recSummary(draft)} error={badCard === "rec"}>
          <RecFields kit={kit} />
        </FormCard>
      </div>
      <div className="form-bar">
        <div className="foot-status">
          <p className="form-error" role="alert">
            {error?.summary}
          </p>
          <span className="copy-slot">{error?.copy ? <CopyButton label={t`Copy error`} className="small ghost" done={t`Error copied. You can paste it to an AI or a technician.`} getText={() => error.copy!} /> : null}</span>
        </div>
        <Link className="btn" to={listHref}>
          {welcome ? t`Maybe later` : t`Cancel`}
        </Link>
        <button className="btn primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
          {busy ? (
            <>
              <span className="spin" aria-hidden="true" />
              <span>{phase.kind === "testing" ? t`Testing connection…` : t`Saving…`}</span>
            </>
          ) : (
            <span>{t`Test and save`}</span>
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
          <h1>{t`Add your first camera`}</h1>
          <p>{t`When you're done, press "Test and save". If the connection works, it's saved and starts recording right away.`}</p>
        </header>
        {body}
      </main>
    );
  }
  return (
    <SettingsSubpage title={t`Add camera`} back={listHref}>
      {body}
    </SettingsSubpage>
  );
}

/**
 * 新增（含首次使用的 /welcome）與編輯攝影機。編輯時從攝影機快取找這台，交給 CameraEditPage；
 * 各區塊的對話框只在打開時取一次設定，之後 SSE 推來的狀態更新不會蓋掉正在編輯的值。
 */
export function CameraFormPage({ id, mode }: { id: string | null; mode: CameraFormMode }) {
  const { t } = useLingui();
  const cams = useQuery({ ...camerasQuery, enabled: id !== null });
  const [round, setRound] = useState(0);
  // 刪除後快取裡已經沒有這台，但還沒換頁；別閃一下「找不到」
  const last = useRef<CameraDto | null>(null);
  if (id === null) return <NewCameraForm key={`new-${round}`} welcome={mode === "welcome"} onAgain={() => setRound((n) => n + 1)} />;
  if (cams.isPending) return <Spinner />;
  if (cams.isError) return <ErrorBox error={cams.error} onRetry={() => void cams.refetch()} />;
  const cam = cams.data.find((c) => c.id === id) ?? (last.current?.id === id ? last.current : null);
  if (!cam) return <ErrorBox error={new PageError(t`Camera not found`, t`It may have been deleted.`, { label: t`Back to cameras`, to: "/settings/cameras" })} />;
  last.current = cam;
  return <CameraEditPage key={id} camera={cam} />;
}
