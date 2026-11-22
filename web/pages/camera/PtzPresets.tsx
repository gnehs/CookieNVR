import { useLingui } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PtzPresetDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { errMsg } from "../../format.ts";
import { Button } from "../../ui/Button.tsx";
import { confirmDialog, Dialog } from "../../ui/Dialog.tsx";
import { Field } from "../../ui/Field.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { toast } from "../../ui/toast.tsx";

export interface PtzPresetsProps {
  cameraId: string;
  initial: PtzPresetDto[];
  /** 相機回報的上限；沒回報就是 null */
  max: number | null;
  admin: boolean;
  speed: () => number;
  /** 前往預置點前先停掉方向控制 */
  beforeGo: () => void;
  /** 在面板的狀態列顯示一句話 */
  say: (text: string | null, tone?: "info" | "error") => void;
}

/**
 * 預置點清單：點名稱就前往。管理員另有「儲存目前位置」與編輯模式（覆寫、刪除）。
 * 一般使用者沒有任何預置點時整段不出現。
 */
export function PtzPresets({ cameraId, initial, max, admin, speed, beforeGo, say }: PtzPresetsProps) {
  const { t } = useLingui();
  const [presets, setPresets] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const flash = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flash.current), []);

  const full = max !== null && presets.length >= max;

  // 前往的結果顯示在面板的狀態列，不跳通知
  const goTo = useMutation({
    mutationFn: (p: PtzPresetDto) => api.ptzGotoPreset(cameraId, p.token, speed()),
    meta: { handlesError: true },
    onSuccess: () => {
      flash.current = setTimeout(() => say(null), 1800);
    },
    onError: (e) => say(errMsg(e), "error"),
  });
  const goingTo = goTo.isPending ? goTo.variables.token : null;
  const go = (p: PtzPresetDto) => {
    beforeGo();
    clearTimeout(flash.current);
    const name = p.name;
    say(t`Going to “${name}”`);
    goTo.mutate(p);
  };

  const overwritePreset = useMutation({
    mutationFn: (p: PtzPresetDto) => api.ptzSavePreset(cameraId, { name: p.name, token: p.token }),
    onSuccess: (res, p) => {
      setPresets(res.presets);
      const name = p.name;
      toast(t`Updated “${name}” to the current position`);
    },
  });
  async function overwrite(p: PtzPresetDto) {
    const name = p.name;
    if (await confirmDialog(t`Overwrite preset`, t`Set “${name}” to where the camera is pointing now? The old position will be replaced.`, { confirmLabel: t`Overwrite` })) overwritePreset.mutate(p);
  }

  const removePreset = useMutation({
    mutationFn: (p: PtzPresetDto) => api.ptzRemovePreset(cameraId, { token: p.token }),
    onSuccess: (res, p) => {
      setPresets(res.presets);
      if (res.presets.length === 0) setEditing(false);
      const name = p.name;
      toast(t`Deleted “${name}”`);
    },
  });
  async function remove(p: PtzPresetDto) {
    const name = p.name;
    if (await confirmDialog(t`Delete preset`, t`Delete “${name}”? The preset will be removed from the camera.`, { confirmLabel: t`Delete`, danger: true })) removePreset.mutate(p);
  }

  if (!admin && presets.length === 0) return null;
  return (
    <div className="ptz-section" data-editing={String(editing)}>
      <div className="ptz-sub">
        <h3>{t`Presets`}</h3>
        {admin ? (
          <div className="ptz-sub-tools">
            {presets.length > 0 ? (
              <Button small iconOnly icon="plus" disabled={full} aria-label={t`Save current position`} title={t`Save current position`} aria-describedby="ptz-limit" onClick={() => setAdding(true)} />
            ) : (
              <Button small icon="plus" disabled={full} aria-describedby="ptz-limit" onClick={() => setAdding(true)}>
                {t`Save current position`}
              </Button>
            )}
            {presets.length > 0 ? (
              <Button small variant="ghost" aria-pressed={editing} onClick={() => setEditing(!editing)}>
                {editing ? t`Done` : t`Edit`}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <p className="ptz-hint" id="ptz-limit" hidden={!admin || !full}>
        {full ? t`Limit reached (${max}). Delete one first.` : ""}
      </p>
      <ul className="ptz-presets scroll-fade-x" hidden={presets.length === 0}>
        {presets.map((p) => {
          const name = p.name;
          return (
            <li className="ptz-preset" key={p.token}>
              <button className="ptz-preset-go" type="button" aria-busy={goingTo === p.token ? "true" : undefined} onClick={() => go(p)}>
                <span>{p.name}</span>
              </button>
              {editing ? (
                <span className="ptz-preset-tools">
                  <Button iconOnly variant="ghost" aria-label={t`Set “${name}” to the current position`} title={t`Set to current position`} onClick={() => void overwrite(p)}>
                    <Icon name="crosshair" size={18} />
                  </Button>
                  <Button iconOnly variant="ghost" className="danger" aria-label={t`Delete “${name}”`} title={t`Delete`} onClick={() => void remove(p)}>
                    <Icon name="trash" size={18} />
                  </Button>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {admin && presets.length === 0 ? <p className="ptz-hint">{t`No presets yet. Turn the camera to the position you want, then press “Save current position”.`}</p> : null}
      <AddPresetDialog cameraId={cameraId} open={adding} onOpenChange={setAdding} onSaved={setPresets} />
    </div>
  );
}

function AddPresetDialog({ cameraId, open, onOpenChange, onSaved }: { cameraId: string; open: boolean; onOpenChange: (o: boolean) => void; onSaved: (presets: PtzPresetDto[]) => void }) {
  const { t } = useLingui();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const save = useMutation({
    mutationFn: (name: string) => api.ptzSavePreset(cameraId, { name }),
    meta: { handlesError: true },
    onSuccess: (res, name) => {
      onSaved(res.presets);
      toast(t`Saved “${name}”`);
      onOpenChange(false);
    },
    onError: (err) => setError(errMsg(err)),
  });
  const busy = save.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = input.current!.value.trim();
    if (!value) {
      setError(t`Give this position a name`);
      return input.current!.focus();
    }
    setError("");
    save.mutate(value);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t`Save current position`} initialFocus={input} onClosed={() => setError("")}>
      <form className="form" onSubmit={submit}>
        <Field label={t`Preset name`} hint={t`Where the camera is pointing now is stored on the camera.`} error={error}>
          <input ref={input} type="text" maxLength={30} autoComplete="off" placeholder={t`e.g. Front door`} />
        </Field>
        <div className="dlg-actions">
          <Button onClick={() => onOpenChange(false)}>{t`Cancel`}</Button>
          <Button type="submit" variant="primary" aria-busy={busy || undefined} disabled={busy}>
            {t`Save`}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
