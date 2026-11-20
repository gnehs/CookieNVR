import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import type { CameraDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { camerasQuery, settingsQuery, systemQuery } from "../../data/queries.ts";
import { errMsg, formatBytes } from "../../format.ts";
import { SwitchRow } from "../../ui/controls.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { toast } from "../../ui/toast.tsx";

/** 不勾選時，刪除攝影機只移除設定；已錄的片段留在硬碟上，照保留天數與最低剩餘空間清除，但介面上已經沒有入口可以回放 */
async function keepMessage(qc: QueryClient): Promise<string> {
  try {
    const { continuousDays: c, eventDays: e } = (await qc.fetchQuery(settingsQuery)).retention;
    if (c === 0 && e === 0) {
      return t`This stops recording and removes the camera. Existing recordings stay on disk but can no longer be played back, and retention is set to unlimited, so the oldest are deleted only when space runs low. Until then they keep using space.`;
    }
    const days = (n: number) => (n === 0 ? t`unlimited` : plural(n, { one: "# day", other: "# days" }));
    const continuous = days(c);
    const events = days(e);
    return t`This stops recording and removes the camera. Existing recordings stay on disk but can no longer be played back. They keep using space until they pass the retention period (continuous ${continuous}, events ${events}) and are then deleted automatically.`;
  } catch {
    return t`This stops recording and removes the camera. Existing recordings stay on disk but can no longer be played back. They keep using space until they pass the retention period and are then deleted automatically.`;
  }
}

const purgeMessage = () => t`This stops recording and removes the camera. All of its recordings are also deleted right away and can't be recovered.`;

interface Ask {
  name: string;
  keep: string;
  /** 這台佔的空間；0 表示沒有錄影（不顯示勾選項），undefined 是問不到 */
  bytes: number | undefined;
  resolve: (purge: boolean | null) => void;
}

/**
 * 刪除攝影機：先問（可以勾「同時刪除這台的錄影」），再刪，並把它從攝影機清單的快取拿掉。
 * `remove(cam)` 在真的刪掉時回傳 true；`dialog` 要放進畫面裡。
 */
export function useDeleteCamera(): { dialog: ReactNode; remove: (cam: CameraDto) => Promise<boolean> } {
  const { t } = useLingui();
  const qc = useQueryClient();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [open, setOpen] = useState(false);
  const [purge, setPurge] = useState(false);
  const confirmBtn = useRef<HTMLButtonElement>(null);

  const answer = (v: boolean | null) => {
    ask?.resolve(v);
    setOpen(false);
  };

  const remove = async (cam: CameraDto): Promise<boolean> => {
    const [bytes, keep] = await Promise.all([
      qc.fetchQuery({ ...systemQuery, staleTime: 0 }).then((s) => s.usage.find((u) => u.cameraId === cam.id)?.bytes ?? 0, () => undefined),
      keepMessage(qc),
    ]);
    const chosen = await new Promise<boolean | null>((resolve) => {
      setPurge(false);
      setAsk({ name: cam.config.name, keep, bytes, resolve });
      setOpen(true);
    });
    if (chosen === null) return false;
    try {
      await api.deleteCamera(cam.id, chosen);
    } catch (e) {
      toast(errMsg(e), "error");
      return false;
    }
    qc.setQueryData(camerasQuery.queryKey, (list) => list?.filter((c) => c.id !== cam.id));
    void qc.invalidateQueries({ queryKey: systemQuery.queryKey });
    const name = cam.config.name;
    toast(t`Deleted "${name}"`);
    return true;
  };

  const askName = ask?.name ?? "";
  const freed = ask?.bytes === undefined ? "" : formatBytes(ask.bytes);
  const dialog = (
    <Dialog open={open} onOpenChange={(o) => !o && answer(null)} title={ask ? t`Delete "${askName}"?` : ""} initialFocus={confirmBtn} onClosed={() => setAsk(null)}>
      <p className="dlg-text" aria-live="polite">
        {purge ? purgeMessage() : ask?.keep}
      </p>
      {ask && ask.bytes !== 0 ? (
        <div className="dlg-option">
          <SwitchRow title={t`Also delete this camera's recordings`} desc={ask.bytes === undefined ? undefined : t`Frees ${freed}`} checked={purge} onChange={setPurge} />
        </div>
      ) : null}
      <div className="dlg-actions">
        <button className="btn" type="button" onClick={() => answer(null)}>
          {t`Cancel`}
        </button>
        <button ref={confirmBtn} className="btn danger solid" type="button" onClick={() => answer(purge)}>
          {purge ? t`Delete camera and recordings` : t`Delete camera`}
        </button>
      </div>
    </Dialog>
  );

  return { dialog, remove };
}
