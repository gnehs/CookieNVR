import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CameraDto, CropBox, FrigateConfigResultDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { camerasQuery } from "../../data/queries.ts";
import { errMsg, formatBytes } from "../../format.ts";
import { ClassesEditor } from "../../states/ClassesEditor.tsx";
import { CropEditor } from "../../states/CropEditor.tsx";
import { classesError, defaultClasses, DEFAULT_CROP, MAX_NAME, pickFrigateSensor, rowsOf, sensorNameError, type ClassRow } from "../../states/model.ts";
import { putSensor } from "../../states/queries.ts";
import { Button } from "../../ui/Button.tsx";
import { Tiles } from "../../ui/controls.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { ErrorBox, PageError, Spinner } from "../../ui/states.tsx";
import { toast } from "../../ui/toast.tsx";
import { SettingsSubpage } from "../settings/SettingsLayout.tsx";

type Source = "recording" | "import";
type Step = 0 | 1 | 2;
const STEPS: readonly MessageDescriptor[] = [msg`What to detect`, msg`Box the area`, msg`Where pictures come from`];

/** 從 Frigate 設定帶進來的值：建立時一起送出 */
type Tuning = Pick<FrigateConfigResultDto["sensors"][number], "threshold" | "intervalSec" | "onMotion">;

/** 新增狀態感應器：三步（名稱與類別 → 框區域 → 訓練畫面的來源），建立後直接到感應器頁標記 */
export function NewSensorPage({ cameraId }: { cameraId: string }) {
  const { t } = useLingui();
  const cams = useQuery(camerasQuery);
  if (cams.isPending) return <Spinner />;
  if (cams.isError) return <ErrorBox error={cams.error} onRetry={() => void cams.refetch()} />;
  const cam = cams.data.find((c) => c.id === cameraId);
  if (!cam) return <ErrorBox error={new PageError(t`Camera not found`, t`It may have been deleted.`, { label: t`Back to cameras`, to: "/settings/cameras" })} />;
  return <Wizard cam={cam} />;
}

function Wizard({ cam }: { cam: CameraDto }) {
  const { t, i18n } = useLingui();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(0);
  const [name, setName] = useState("");
  const [rows, setRows] = useState<ClassRow[]>(() => rowsOf(defaultClasses()).map((r) => ({ ...r, original: null })));
  const [crop, setCrop] = useState<CropBox>(DEFAULT_CROP);
  const [tuning, setTuning] = useState<Tuning | null>(null);
  const [source, setSource] = useState<Source>(cam.config.record.enabled ? "recording" : "import");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<{ message: string; field?: "name" | "classes" | "file"; index?: number | null } | null>(null);
  // 建立之後上傳 Frigate 資料集的進度（0 到 1）；null 表示還沒到上傳
  const [uploading, setUploading] = useState<number | null>(null);
  const head = useRef<HTMLHeadingElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      if (matchMedia("(pointer: fine)").matches) nameInput.current?.focus();
      return;
    }
    head.current?.focus({ preventScroll: true });
    head.current?.scrollIntoView({ block: "nearest" });
  }, [step]);

  const checkStep = (s: Step): boolean => {
    if (s === 0) {
      const n = sensorNameError(name);
      if (n) return setError({ message: n, field: "name" }), false;
      const c = classesError(rows.map((r) => r.name));
      if (c) return setError({ message: c.message, field: "classes", index: c.index }), false;
    }
    if (s === 2 && source === "import" && !file) return setError({ message: t`Choose the zip file exported from Frigate`, field: "file" }), false;
    setError(null);
    return true;
  };

  const create = useMutation({
    mutationFn: async () => {
      const created = await api.createState({
        cameraId: cam.id,
        config: { name: name.trim(), classes: rows.map((r) => r.name.trim()), crop, ...(tuning ?? {}) },
        collect: source === "recording",
      });
      putSensor(qc, created);
      if (source !== "import" || !file) return created;
      setUploading(0);
      try {
        const imported = await api.importStateDataset(created.id, file, setUploading);
        putSensor(qc, imported);
        return imported;
      } catch (err) {
        const sensorName = created.config.name;
        const reason = errMsg(err);
        toast(t`“${sensorName}” was created, but the import failed: ${reason}`, "error");
        return created;
      }
    },
    meta: { handlesError: true },
    onSuccess: (sensor) => void navigate({ to: "/settings/cameras/$id/states/$sensorId", params: { id: cam.id, sensorId: sensor.id }, replace: true }),
    onError: (err) => setError({ message: errMsg(err) }),
  });
  // 成功後馬上換頁，按鈕維持忙碌到畫面換掉
  const busy = create.isPending || create.isSuccess;
  const trimmedName = name.trim();
  const uploadPct = Math.round((uploading ?? 0) * 100);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (step < 2) {
      if (checkStep(step)) setStep((step + 1) as Step);
      return;
    }
    if (!checkStep(2)) return;
    create.mutate();
  };

  return (
    <SettingsSubpage title={t`Add state sensor`} back={`/settings/cameras/${cam.id}`}>
      <form className="wiz" noValidate onSubmit={submit}>
        <ol className="wiz-steps" aria-label={t`Steps`}>
          {STEPS.map((label, i) => (
            <li key={label.id} data-state={i < step ? "done" : i === step ? "current" : "todo"} aria-current={i === step ? "step" : undefined}>
              <span className="wiz-dot num">{i < step ? <Icon name="check" size={14} /> : i + 1}</span>
              <span className="wiz-label">{i18n._(label)}</span>
            </li>
          ))}
        </ol>

        <section className="card wiz-card">
          <h2 ref={head} tabIndex={-1} className="wiz-title">
            {i18n._(STEPS[step]!)}
          </h2>

          {step === 0 ? (
            <div className="wiz-body">
              <label className="wiz-field">
                <span className="wiz-field-label">{t`Name`}</span>
                <input
                  ref={nameInput}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={MAX_NAME}
                  placeholder={t`e.g. Roller shutter, garage door, window`}
                  aria-invalid={error?.field === "name" || undefined}
                  value={name}
                  onChange={(e) => {
                    setName(e.currentTarget.value);
                    if (error?.field === "name") setError(null);
                  }}
                />
              </label>
              <div className="wiz-field">
                <span className="wiz-field-label" id="cls-label">
                  <Trans>What states it can be in</Trans>
                </span>
                <ClassesEditor
                  rows={rows}
                  onRows={(r) => {
                    setRows(r);
                    if (error?.field === "classes") setError(null);
                  }}
                  invalid={error?.field === "classes" ? (error.index ?? null) : null}
                />
              </div>
            </div>
          ) : step === 1 ? (
            <div className="wiz-body">
              <p className="wiz-lead">{trimmedName ? t`Detection only looks inside the box. Fit it snugly around “${trimmedName}” for the best results.` : t`Detection only looks inside the box. Fit it snugly around the thing to check for the best results.`}</p>
              <CropEditor cameraId={cam.id} value={crop} onChange={setCrop} />
              <FrigatePaste cameraName={cam.config.name} tuning={tuning} onApply={(s) => {
                setCrop(s.crop);
                setTuning({ threshold: s.threshold, intervalSec: s.intervalSec, onMotion: s.onMotion });
                {
                  const frigateName = s.name;
                  toast(t`Imported the area and settings from Frigate “${frigateName}”`);
                }
              }} />
            </div>
          ) : (
            <div className="wiz-body">
              <p className="wiz-lead"><Trans>It needs to see every state first. Pick a way to get pictures, then label which class each one is.</Trans></p>
              <Tiles
                label={t`Where pictures come from`}
                options={[
                  { value: "recording", label: t`Pick from recordings automatically`, desc: cam.config.record.enabled ? t`Picks 24 different frames from this camera’s recordings` : t`Recording is off for this camera, so there’s nothing to pick from`, icon: "film" },
                  { value: "import", label: t`Import Frigate training data`, desc: t`A zip exported from Frigate; its labels come along`, icon: "download" },
                ]}
                value={source}
                onChange={(v) => {
                  setSource(v);
                  if (error?.field === "file") setError(null);
                }}
              />
              {source === "import" ? (
                <label className="file-pick" data-invalid={error?.field === "file" ? "" : undefined}>
                  <input
                    type="file"
                    accept=".zip,application/zip"
                    onChange={(e) => {
                      setFile(e.currentTarget.files?.[0] ?? null);
                      if (error?.field === "file") setError(null);
                    }}
                  />
                  <Icon name="download" size={18} />
                  <span>{file ? file.name : t`Choose a zip file`}</span>
                  <small>{file ? formatBytes(file.size) : t`Training data exported from Frigate, up to 100 MB`}</small>
                </label>
              ) : null}
            </div>
          )}

          <div className="wiz-bar">
            <p className="form-error" role="alert">
              {error?.message}
            </p>
            {step > 0 ? (
              <Button disabled={busy} onClick={() => (setError(null), setStep((step - 1) as Step))}>
                <Trans>Previous</Trans>
              </Button>
            ) : null}
            <Button variant="primary" type="submit" busy={busy}>
              <span>{uploading !== null ? t`Uploading ${uploadPct}%` : busy ? t`Creating…` : step < 2 ? t`Next` : t`Create and start labeling`}</span>
            </Button>
          </div>
        </section>
      </form>
    </SettingsSubpage>
  );
}

/** 進階：貼上 Frigate 的設定，帶入區域、信心門檻與辨識頻率 */
function FrigatePaste({ cameraName, tuning, onApply }: { cameraName: string; tuning: Tuning | null; onApply: (s: FrigateConfigResultDto["sensors"][number]) => void }) {
  const { t } = useLingui();
  const [yaml, setYaml] = useState("");
  const [found, setFound] = useState<FrigateConfigResultDto["sensors"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const foundCount = found?.length ?? 0;
  const read = useMutation({
    mutationFn: () => api.frigateConfig(yaml),
    meta: { handlesError: true },
    onSuccess: (r) => {
      setFound(r.sensors);
      if (r.sensors.length === 1) onApply(r.sensors[0]!);
      else onApply(pickFrigateSensor(r, cameraName));
    },
    onError: (e) => setError(errMsg(e)),
  });
  const busy = read.isPending;
  return (
    <details className="more frigate-paste">
      <summary>{t`Import from Frigate settings`}</summary>
      <div className="frigate-body">
        <p className="hint"><Trans>Paste the classification section of your Frigate config to import the box and detection settings.</Trans></p>
        <textarea rows={6} spellCheck={false} placeholder={"classification:\n  custom:\n    garage:\n      state_config:\n        cameras:\n          …"} value={yaml} onChange={(e) => setYaml(e.currentTarget.value)} aria-label={t`Frigate settings`} />
        <div className="frigate-actions">
          <Button
            small
            onClick={() => {
              setError(null);
              read.mutate();
            }}
            disabled={!yaml.trim()}
            busy={busy}
          >
            <Trans>Import</Trans>
          </Button>
          {error ? <span className="form-error">{error}</span> : tuning ? <span className="hint ok-text">{t`Imported`}</span> : null}
        </div>
        {found && found.length > 1 ? (
          <div className="frigate-pick" role="group" aria-label={t`There are several in the settings; pick one`}>
            <span className="hint">{t`The settings contain ${foundCount} entries; pick the one to use:`}</span>
            {found.map((s) => (
              <Button key={`${s.name}/${s.camera}`} small variant="ghost" onClick={() => onApply(s)}>
                {s.name} ({s.camera})
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}
