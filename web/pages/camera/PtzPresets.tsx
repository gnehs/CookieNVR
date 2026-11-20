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
  const [presets, setPresets] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [goingTo, setGoingTo] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const flash = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flash.current), []);

  const full = max !== null && presets.length >= max;

  async function go(p: PtzPresetDto) {
    beforeGo();
    setGoingTo(p.token);
    clearTimeout(flash.current);
    say(`前往「${p.name}」`);
    try {
      await api.ptzGotoPreset(cameraId, p.token, speed());
      flash.current = setTimeout(() => say(null), 1800);
    } catch (e) {
      say(errMsg(e), "error");
    } finally {
      setGoingTo(null);
    }
  }

  async function overwrite(p: PtzPresetDto) {
    if (!(await confirmDialog("覆寫預置點", `要把「${p.name}」改成鏡頭現在的位置嗎？原本的位置會被取代。`, { confirmLabel: "覆寫" }))) return;
    try {
      setPresets((await api.ptzSavePreset(cameraId, { name: p.name, token: p.token })).presets);
      toast(`已把「${p.name}」更新為目前位置`);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }

  async function remove(p: PtzPresetDto) {
    if (!(await confirmDialog("刪除預置點", `要刪除「${p.name}」嗎？這個預置點會從相機上移除。`, { confirmLabel: "刪除", danger: true }))) return;
    try {
      const next = (await api.ptzRemovePreset(cameraId, { token: p.token })).presets;
      setPresets(next);
      if (next.length === 0) setEditing(false);
      toast(`已刪除「${p.name}」`);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }

  if (!admin && presets.length === 0) return null;
  return (
    <div className="ptz-section" data-editing={String(editing)}>
      <div className="ptz-sub">
        <h3>預置點</h3>
        {admin ? (
          <div className="ptz-sub-tools">
            <Button small icon="plus" disabled={full} aria-describedby="ptz-limit" onClick={() => setAdding(true)}>
              儲存目前位置
            </Button>
            {presets.length > 0 ? (
              <Button small variant="ghost" aria-pressed={editing} onClick={() => setEditing(!editing)}>
                {editing ? "完成" : "編輯"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <p className="ptz-hint" id="ptz-limit" hidden={!admin || !full}>
        {full ? `已達上限（${max} 個），請先刪除一個。` : ""}
      </p>
      <ul className="ptz-presets scroll-fade-x" hidden={presets.length === 0}>
        {presets.map((p) => (
          <li className="ptz-preset" key={p.token}>
            <button className="ptz-preset-go" type="button" aria-busy={goingTo === p.token ? "true" : undefined} onClick={() => void go(p)}>
              <span>{p.name}</span>
            </button>
            {editing ? (
              <span className="ptz-preset-tools">
                <Button iconOnly variant="ghost" aria-label={`把「${p.name}」覆寫成目前位置`} title="覆寫成目前位置" onClick={() => void overwrite(p)}>
                  <Icon name="crosshair" size={18} />
                </Button>
                <Button iconOnly variant="ghost" className="danger" aria-label={`刪除「${p.name}」`} title="刪除" onClick={() => void remove(p)}>
                  <Icon name="trash" size={18} />
                </Button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {admin && presets.length === 0 ? <p className="ptz-hint">還沒有預置點。把鏡頭轉到想要的位置，再按「儲存目前位置」。</p> : null}
      <AddPresetDialog
        open={adding}
        onOpenChange={setAdding}
        save={async (name) => {
          setPresets((await api.ptzSavePreset(cameraId, { name })).presets);
          toast(`已儲存「${name}」`);
        }}
      />
    </div>
  );
}

function AddPresetDialog({ open, onOpenChange, save }: { open: boolean; onOpenChange: (o: boolean) => void; save: (name: string) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = input.current!.value.trim();
    if (!value) {
      setError("請幫這個位置取個名稱");
      return input.current!.focus();
    }
    setError("");
    setBusy(true);
    try {
      await save(value);
      onOpenChange(false);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="儲存目前位置" initialFocus={input} onClosed={() => setError("")}>
      <form className="form" onSubmit={submit}>
        <Field label="預置點名稱" hint="鏡頭現在對著的位置會存到相機裡。" error={error}>
          <input ref={input} type="text" maxLength={30} autoComplete="off" placeholder="例如：大門" />
        </Field>
        <div className="dlg-actions">
          <Button onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="submit" variant="primary" aria-busy={busy || undefined} disabled={busy}>
            儲存
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
