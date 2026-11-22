import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useReducer, useRef, useState, type ReactNode } from "react";
import type { CameraDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { ptzQuery, settingsQuery, systemQuery } from "../../data/queries.ts";
import { modeOf, objectSummary } from "../../detect/object-model.ts";
import { errMsg } from "../../format.ts";
import { statesQuery } from "../../states/queries.ts";
import { Button } from "../../ui/Button.tsx";
import { Dialog, DialogClose } from "../../ui/Dialog.tsx";
import { FormStatus } from "../../ui/FormStatus.tsx";
import { Icon } from "../../ui/Icon.tsx";
import type { IconName } from "../../ui/icons.ts";
import { toast } from "../../ui/toast.tsx";
import { useRetained } from "../../ui/use-retained.ts";
import { SettingsSubpage } from "../settings/SettingsLayout.tsx";
import { putCamera } from "./cache.ts";
import { DetectSection } from "./DetectSection.tsx";
import { BasicFields, ConnFields, RecFields, useFocusError, type FieldKit } from "./fields.tsx";
import { basicSummary, connKey, connSummary, DEFAULT_PTZ, detectSummary, draftOf, editReducer, planSave, probeFailure, recSummary, sectionChanged, type Draft, type SectionEdit, type SectionKey } from "./form-model.ts";
import { HomekitSection, homekitQuery, homekitSummary } from "./HomekitSection.tsx";
import { PtzPrefsField, ptzSummary } from "./PtzPrefs.tsx";
import { sensorsOf, StatesSection, statesSummary } from "./StatesSection.tsx";
import { useDeleteCamera } from "./useDeleteCamera.tsx";

/** 不是表單的區塊：打開看、在裡面直接操作，沒有儲存 */
type InfoKey = "states" | "homekit";

const TITLE: Record<SectionKey | InfoKey, MessageDescriptor> = {
  basic: msg`Basic`,
  conn: msg`Connection`,
  rec: msg`Recording`,
  detect: msg`Detection`,
  ptz: msg`Camera control`,
  states: msg`State recognition`,
  homekit: msg`Apple Home`,
};

const ICON: Record<SectionKey | InfoKey, IconName> = {
  basic: "edit",
  conn: "link",
  rec: "rec",
  detect: "activity",
  ptz: "crosshair",
  states: "toggle",
  homekit: "home",
};

/** 桌面上要放得下畫面預覽與遮罩編輯的區塊；手機上這些是全高的面板 */
const WIDE = new Set<SectionKey | InfoKey>(["detect"]);

function SectionRow({ k, summary, onOpen }: { k: SectionKey | InfoKey; summary: string; onOpen: () => void }) {
  const { i18n } = useLingui();
  return (
    <button type="button" className="row-item sec-row" onClick={onOpen} aria-haspopup="dialog">
      <span className="row-ico">
        <Icon name={ICON[k]} size={18} />
      </span>
      <span className="row-text">
        <b>{i18n._(TITLE[k])}</b>
        <small className="truncate">{summary}</small>
      </span>
      <Icon name="chevron" size={16} />
    </button>
  );
}

/** 一個表單區塊的內容；改動只進 edit.draft，按「儲存」才送出 */
function SectionFields({ edit, camera, set, objects }: { edit: SectionEdit; camera: CameraDto; set: (patch: Partial<Draft>) => void; objects: boolean }) {
  const kit: FieldKit = { draft: edit.draft, set, error: edit.error };
  const d = edit.draft;
  switch (edit.key) {
    case "basic":
      return <BasicFields kit={kit} existing />;
    case "conn":
      return <ConnFields kit={kit} existing={camera} />;
    case "rec":
      return <RecFields kit={kit} />;
    case "detect":
      return d.detect ? <DetectSection camera={camera} value={d.detect} saved={edit.start.detect!} onChange={(patch) => set({ detect: { ...d.detect!, ...patch } })} onvif={d.type === "tapo" || d.onvifOn} active={edit.open} objects={objects} /> : null;
    case "ptz":
      return (
        <div className="set-block">
          <PtzPrefsField value={d.ptz ?? DEFAULT_PTZ} onChange={(ptz) => set({ ptz })} />
        </div>
      );
  }
}

/**
 * 編輯攝影機：一份區塊清單，點一列打開那個區塊的對話框。每個對話框各自取消、各自儲存，
 * 儲存時只把這個區塊的變更合併進目前的設定再送出（見 form-model 的 planSave）。
 */
export function CameraEditPage({ camera }: { camera: CameraDto }) {
  const { t, i18n } = useLingui();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [edit, dispatch] = useReducer(editReducer, null);
  const [info, setInfo] = useState<InfoKey | null>(null);
  const [shownInfo, clearShownInfo] = useRetained(info);
  const fields = useRef<HTMLFormElement>(null);
  useFocusError(fields, edit?.error ?? null);

  const objectsOn = useQuery(settingsQuery).data?.objects.enabled ?? false;
  const homekit = useQuery(homekitQuery(camera.id)).data;
  const sensors = useQuery({ ...statesQuery, select: (list) => sensorsOf(list, camera.id) }).data;
  const ptzSupported = useQuery(ptzQuery(camera.id)).data?.supported === true;
  const del = useDeleteCamera();

  const current = draftOf(camera.config);
  const detect = current.detect!;
  const summary: Record<SectionKey | InfoKey, string> = {
    basic: basicSummary(current, true),
    conn: connSummary(current),
    rec: recSummary(current),
    detect: detectSummary(detect, objectsOn && detect.enabled ? objectSummary(modeOf(detect.objectMode), detect.labels) : null),
    ptz: ptzSummary(current.ptz ?? DEFAULT_PTZ),
    states: statesSummary(sensors),
    homekit: homekitSummary(homekit),
  };
  const rows: (SectionKey | InfoKey)[] = ["basic", "conn", "rec", "detect", "states", ...(ptzSupported ? (["ptz"] as const) : []), "homekit"];
  const open = (k: SectionKey | InfoKey) => (k === "states" || k === "homekit" ? setInfo(k) : dispatch({ type: "open", key: k, from: current }));

  const save = async () => {
    if (!edit) return;
    const plan = planSave(edit, camera.config, homekit ? { enabled: homekit.enabled } : camera.config.homekit);
    if ("error" in plan) return dispatch({ type: "fail", error: plan.error });
    dispatch({ type: "submit", status: plan.test ? "testing" : "saving" });
    try {
      if (plan.test) {
        const probe = await api.testCamera(plan.test);
        if (!probe.ok) return dispatch({ type: "fail", error: probeFailure(plan.test, probe) });
        dispatch({ type: "submit", status: "saving" });
      }
      const cam = await api.updateCamera(camera.id, plan.config);
      putCamera(qc, cam);
      void qc.invalidateQueries({ queryKey: systemQuery.queryKey });
      dispatch({ type: "close" });
      toast(plan.test ? t`Connected and saved` : t`Saved`);
    } catch (err) {
      dispatch({ type: "fail", error: { summary: errMsg(err) } });
    }
  };

  const removeCamera = async () => {
    if (await del.remove(camera)) void navigate({ to: "/settings/cameras" });
  };

  const cameraName = camera.config.name;
  const busy = edit !== null && edit.status !== "editing";
  const dirty = edit !== null && sectionChanged(edit.key, edit.draft, edit.start);
  // 連線改過時按鈕寫「測試並儲存」，讓人知道會先連一次
  const needsTest = edit?.key === "conn" && connKey(edit.draft) !== connKey(current);
  const footer = edit ? (
    <>
      <FormStatus error={edit.error} />
      <DialogClose disabled={busy}>{t`Cancel`}</DialogClose>
      <Button variant="primary" busy={busy} disabled={!dirty} onClick={() => void save()}>
        <span>{busy ? (edit.status === "testing" ? t`Testing connection…` : t`Saving…`) : needsTest ? t`Test and save` : t`Save`}</span>
      </Button>
    </>
  ) : null;

  const infoBody: Record<InfoKey, ReactNode> = {
    states: <StatesSection camera={camera} />,
    homekit: <HomekitSection camera={camera} />,
  };
  return (
    <SettingsSubpage title={t`Edit "${cameraName}"`} back="/settings/cameras">
      <div className="card row-list sec-list">
        {rows.map((k) => (
          <SectionRow key={k} k={k} summary={summary[k]} onOpen={() => open(k)} />
        ))}
      </div>
      <section className="danger-zone">
        <div className="danger-text">
          <b>{t`Delete this camera`}</b>
          <p>{t`Stops recording and removes its settings. You can choose whether to delete the recorded video too.`}</p>
        </div>
        <button className="btn danger" type="button" onClick={() => void removeCamera()}>
          <Icon name="trash" size={16} />
          {t`Delete camera`}
        </button>
      </section>

      <Dialog open={edit?.open ?? false} onOpenChange={(o) => !o && dispatch({ type: "close" })} title={edit ? i18n._(TITLE[edit.key]) : ""} guard={busy ? "busy" : dirty ? "dirty" : false} wide={edit ? WIDE.has(edit.key) : false} footer={footer}>
        <form
          className="dlg-fields"
          noValidate
          ref={fields}
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && dirty) void save();
          }}
        >
          {edit ? <SectionFields edit={edit} camera={camera} set={(patch) => dispatch({ type: "patch", patch })} objects={objectsOn} /> : null}
        </form>
      </Dialog>
      <Dialog open={info !== null} onOpenChange={(o) => !o && setInfo(null)} title={shownInfo ? i18n._(TITLE[shownInfo]) : ""} footer={<DialogClose className="btn primary">{t`Done`}</DialogClose>} onClosed={clearShownInfo}>
        <div className="dlg-fields">{shownInfo ? infoBody[shownInfo] : null}</div>
      </Dialog>
      {del.dialog}
    </SettingsSubpage>
  );
}
