import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CameraDto, CropBox, FrigateConfigResultDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { camerasQuery } from "../../data/queries.ts";
import { errMsg, formatBytes } from "../../format.ts";
import { ClassesEditor } from "../../states/ClassesEditor.tsx";
import { CropEditor } from "../../states/CropEditor.tsx";
import { classesError, DEFAULT_CLASSES, DEFAULT_CROP, MAX_NAME, pickFrigateSensor, rowsOf, sensorNameError, type ClassRow } from "../../states/model.ts";
import { putSensor } from "../../states/queries.ts";
import { Button } from "../../ui/Button.tsx";
import { Tiles } from "../../ui/controls.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { ErrorBox, PageError, Spinner } from "../../ui/states.tsx";
import { toast } from "../../ui/toast.tsx";
import { SettingsSubpage } from "../settings/SettingsLayout.tsx";

type Source = "recording" | "import";
type Step = 0 | 1 | 2;
const STEPS = ["要判斷什麼", "框出區域", "畫面從哪裡來"] as const;

/** 從 Frigate 設定帶進來的值：建立時一起送出 */
type Tuning = Pick<FrigateConfigResultDto["sensors"][number], "threshold" | "intervalSec" | "onMotion">;

type Phase = { kind: "editing" } | { kind: "creating" } | { kind: "uploading"; progress: number };

/** 新增狀態感應器：三步（名稱與類別 → 框區域 → 訓練畫面的來源），建立後直接到感應器頁標記 */
export function NewSensorPage({ cameraId }: { cameraId: string }) {
  const cams = useQuery(camerasQuery);
  if (cams.isPending) return <Spinner />;
  if (cams.isError) return <ErrorBox error={cams.error} onRetry={() => void cams.refetch()} />;
  const cam = cams.data.find((c) => c.id === cameraId);
  if (!cam) return <ErrorBox error={new PageError("找不到這台攝影機", "它可能已經被刪除了。", { label: "回到攝影機列表", to: "/settings/cameras" })} />;
  return <Wizard cam={cam} />;
}

function Wizard({ cam }: { cam: CameraDto }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(0);
  const [name, setName] = useState("");
  const [rows, setRows] = useState<ClassRow[]>(() => rowsOf(DEFAULT_CLASSES).map((r) => ({ ...r, original: null })));
  const [crop, setCrop] = useState<CropBox>(DEFAULT_CROP);
  const [tuning, setTuning] = useState<Tuning | null>(null);
  const [source, setSource] = useState<Source>(cam.config.record.enabled ? "recording" : "import");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<{ message: string; field?: "name" | "classes" | "file"; index?: number | null } | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });
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
    if (s === 2 && source === "import" && !file) return setError({ message: "請選擇 Frigate 匯出的 zip 檔", field: "file" }), false;
    setError(null);
    return true;
  };

  const busy = phase.kind !== "editing";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (step < 2) {
      if (checkStep(step)) setStep((step + 1) as Step);
      return;
    }
    if (!checkStep(2)) return;
    setPhase({ kind: "creating" });
    try {
      const created = await api.createState({
        cameraId: cam.id,
        config: { name: name.trim(), classes: rows.map((r) => r.name.trim()), crop, ...(tuning ?? {}) },
        collect: source === "recording",
      });
      putSensor(qc, created);
      let sensor = created;
      if (source === "import" && file) {
        setPhase({ kind: "uploading", progress: 0 });
        try {
          sensor = await api.importStateDataset(created.id, file, (progress) => setPhase({ kind: "uploading", progress }));
          putSensor(qc, sensor);
        } catch (err) {
          toast(`已建立「${created.config.name}」，但匯入失敗：${errMsg(err)}`, "error");
        }
      }
      void navigate({ to: "/settings/cameras/$id/states/$sensorId", params: { id: cam.id, sensorId: sensor.id }, replace: true });
    } catch (err) {
      setError({ message: errMsg(err) });
      setPhase({ kind: "editing" });
    }
  };

  return (
    <SettingsSubpage title="新增狀態感應器" back={`/settings/cameras/${cam.id}`}>
      <form className="wiz" noValidate onSubmit={submit}>
        <ol className="wiz-steps" aria-label="步驟">
          {STEPS.map((label, i) => (
            <li key={label} data-state={i < step ? "done" : i === step ? "current" : "todo"} aria-current={i === step ? "step" : undefined}>
              <span className="wiz-dot num">{i < step ? <Icon name="check" size={14} /> : i + 1}</span>
              <span className="wiz-label">{label}</span>
            </li>
          ))}
        </ol>

        <section className="card wiz-card">
          <h2 ref={head} tabIndex={-1} className="wiz-title">
            {STEPS[step]}
          </h2>

          {step === 0 ? (
            <div className="wiz-body">
              <label className="wiz-field">
                <span className="wiz-field-label">名稱</span>
                <input
                  ref={nameInput}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={MAX_NAME}
                  placeholder="例如：鐵捲門、車庫門、窗戶"
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
                  它會有哪些樣子
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
              <p className="wiz-lead">只看框裡的畫面來判斷。框得剛好包住{name.trim() ? `「${name.trim()}」` : "要判斷的東西"}，判斷會最準。</p>
              <CropEditor cameraId={cam.id} value={crop} onChange={setCrop} />
              <FrigatePaste cameraName={cam.config.name} tuning={tuning} onApply={(s) => {
                setCrop(s.crop);
                setTuning({ threshold: s.threshold, intervalSec: s.intervalSec, onMotion: s.onMotion });
                toast(`已帶入 Frigate「${s.name}」的區域與設定`);
              }} />
            </div>
          ) : (
            <div className="wiz-body">
              <p className="wiz-lead">要先讓它看過每一種樣子。選一個方式取得畫面，接著由你標記每張是哪一類。</p>
              <Tiles
                label="畫面的來源"
                options={[
                  { value: "recording", label: "從錄影自動挑選", desc: cam.config.record.enabled ? "從這台的錄影挑出 24 張不同的畫面" : "這台沒有開錄影，挑不到畫面", icon: "film" },
                  { value: "import", label: "匯入 Frigate 訓練資料", desc: "Frigate 匯出的 zip，標記會一起帶進來", icon: "download" },
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
                  <span>{file ? file.name : "選擇 zip 檔"}</span>
                  <small>{file ? formatBytes(file.size) : "Frigate 匯出的訓練資料，最大 100 MB"}</small>
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
                上一步
              </Button>
            ) : null}
            <button className="btn primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
              {busy ? <span className="spin" aria-hidden="true" /> : null}
              <span>{phase.kind === "uploading" ? `上傳中 ${Math.round(phase.progress * 100)}%` : phase.kind === "creating" ? "建立中…" : step < 2 ? "下一步" : "建立並開始標記"}</span>
            </button>
          </div>
        </section>
      </form>
    </SettingsSubpage>
  );
}

/** 進階：貼上 Frigate 的設定，帶入區域、信心門檻與辨識頻率 */
function FrigatePaste({ cameraName, tuning, onApply }: { cameraName: string; tuning: Tuning | null; onApply: (s: FrigateConfigResultDto["sensors"][number]) => void }) {
  const [yaml, setYaml] = useState("");
  const [found, setFound] = useState<FrigateConfigResultDto["sensors"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const read = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.frigateConfig(yaml);
      setFound(r.sensors);
      if (r.sensors.length === 1) onApply(r.sensors[0]!);
      else onApply(pickFrigateSensor(r, cameraName));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="more frigate-paste">
      <summary>從 Frigate 的設定帶入</summary>
      <div className="frigate-body">
        <p className="hint">貼上 Frigate 設定檔裡 classification 那一段，會帶入框選的區域與判斷設定。</p>
        <textarea rows={6} spellCheck={false} placeholder={"classification:\n  custom:\n    garage:\n      state_config:\n        cameras:\n          …"} value={yaml} onChange={(e) => setYaml(e.currentTarget.value)} aria-label="Frigate 設定" />
        <div className="frigate-actions">
          <Button small onClick={() => void read()} disabled={busy || !yaml.trim()}>
            {busy ? <span className="spin" aria-hidden="true" /> : null}
            帶入
          </Button>
          {error ? <span className="form-error">{error}</span> : tuning ? <span className="hint ok-text">已帶入</span> : null}
        </div>
        {found && found.length > 1 ? (
          <div className="frigate-pick" role="group" aria-label="設定裡有好幾個，選一個">
            <span className="hint">設定裡有 {found.length} 個，選要用的那個：</span>
            {found.map((s) => (
              <Button key={`${s.name}/${s.camera}`} small variant="ghost" onClick={() => onApply(s)}>
                {s.name}（{s.camera}）
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}
