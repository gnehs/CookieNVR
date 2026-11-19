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
  const lead = "會停止錄影並移除這台攝影機。已錄的影片會留在硬碟上，但之後無法再回放，";
  try {
    const { continuousDays: c, eventDays: e } = (await qc.fetchQuery(settingsQuery)).retention;
    if (c === 0 && e === 0) return `${lead}而且保留天數設為不限，只有空間不夠時才會從最舊的開始刪除。在那之前會一直佔用空間。`;
    const days = (n: number) => (n === 0 ? "不限" : `${n} 天`);
    return `${lead}會繼續佔用空間，直到超過保留天數（連續錄影 ${days(c)}、事件片段 ${days(e)}）才自動刪除。`;
  } catch {
    return `${lead}會繼續佔用空間，直到超過保留天數才自動刪除。`;
  }
}

const PURGE_MESSAGE = "會停止錄影並移除這台攝影機，這台所有的錄影也會立刻永久刪除，無法復原。";

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
    toast(`已刪除「${cam.config.name}」`);
    return true;
  };

  const dialog = (
    <Dialog open={open} onOpenChange={(o) => !o && answer(null)} title={ask ? `刪除「${ask.name}」？` : ""} initialFocus={confirmBtn} onClosed={() => setAsk(null)}>
      <p className="dlg-text" aria-live="polite">
        {purge ? PURGE_MESSAGE : ask?.keep}
      </p>
      {ask && ask.bytes !== 0 ? (
        <div className="dlg-option">
          <SwitchRow title="同時刪除這台的錄影" desc={ask.bytes === undefined ? undefined : `會釋放 ${formatBytes(ask.bytes)}`} checked={purge} onChange={setPurge} />
        </div>
      ) : null}
      <div className="dlg-actions">
        <button className="btn" type="button" onClick={() => answer(null)}>
          取消
        </button>
        <button ref={confirmBtn} className="btn danger solid" type="button" onClick={() => answer(purge)}>
          {purge ? "刪除攝影機與錄影" : "刪除攝影機"}
        </button>
      </div>
    </Dialog>
  );

  return { dialog, remove };
}
