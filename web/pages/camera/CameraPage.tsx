import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { CameraDto } from "../../../src/api-types.ts";
import { camerasQuery } from "../../data/queries.ts";
import { useMe } from "../../data/session.ts";
import { cameraStatus } from "../../health.ts";
import { LiveFrame } from "../../live/LiveFrame.tsx";
import type { Quality } from "../../live/transport.ts";
import { liveSupported } from "../../live/video.ts";
import { Player } from "../../playback/player.ts";
import { ButtonLink } from "../../ui/Button.tsx";
import { Segmented } from "../../ui/controls.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Badge } from "../../ui/Panel.tsx";
import { EmptyState, ErrorBox, Spinner } from "../../ui/states.tsx";
import { LiveChip, LivePill, savedQuality, saveQuality, toggleFullscreen, useLiveVideo } from "./live.tsx";
import { Playback } from "./Playback.tsx";
import { PtzPanel } from "./PtzPanel.tsx";
import { daysQuery } from "./queries.ts";
import { viewOf } from "./search.ts";
import { StateChips } from "./StateChips.tsx";

const route = getRouteApi("/_authed/_shell/cameras/$id");

function NotFound() {
  const { t } = useLingui();
  return (
    <EmptyState
      icon="camera"
      title={t`Camera not found`}
      body={t`It may have been deleted.`}
      action={
        <ButtonLink to="/cameras" icon="left">
          {t`Back to cameras`}
        </ButtonLink>
      }
    />
  );
}

/** 單台頁：即時畫面與這台的錄影在同一頁，即時是時間軸的右端 */
export function CameraPage() {
  const { id } = route.useParams();
  const cams = useQuery(camerasQuery);
  if (cams.isPending) return <Spinner />;
  if (cams.isError) return <ErrorBox error={cams.error} onRetry={() => void cams.refetch()} />;
  const cam = cams.data.find((c) => c.id === id);
  if (!cam) return <NotFound />;
  return <CameraScreen key={id} cam={cam} />;
}

function CameraScreen({ cam }: { cam: CameraDto }) {
  const { t } = useLingui();
  const admin = useMe().role === "admin";
  const view = viewOf(route.useSearch());
  const [quality, setQuality] = useState<Quality>(savedQuality);
  const daysQ = useQuery(daysQuery(cam.id));
  const playable = Player.supported() && (daysQ.data?.length ?? 0) > 0;
  const live = !playable || view.kind === "live";
  const enabled = cam.config.enabled;
  const st = cameraStatus(cam);

  let body;
  if (daysQ.isPending) body = <Spinner />;
  else if (daysQ.isError) body = <ErrorBox error={daysQ.error} onRetry={() => void daysQ.refetch()} />;
  else if (playable) body = <Playback cam={cam} days={daysQ.data} view={view} quality={quality} admin={admin} />;
  else body = <LiveOnly cam={cam} quality={quality} admin={admin} hasRecordings={daysQ.data.length > 0} />;

  return (
    <div className="pb">
      <header className="page-head sub-head live-head pb-head">
        <BackButton />
        <div className="live-title">
          <h1>{cam.config.name}</h1>
          <span className="live-pill">{st.quiet ? null : <Badge kind={st.tone}>{st.label}</Badge>}</span>
        </div>
        {live && enabled ? (
          <div className="page-actions">
            <Segmented
              label={t`Quality`}
              options={[
                { value: "sd", label: t`Standard` },
                { value: "hd", label: t`High quality` },
              ]}
              value={quality}
              onChange={(q) => {
                setQuality(q);
                saveQuality(q);
              }}
            />
          </div>
        ) : null}
      </header>
      {live && !liveSupported() ? (
        <p className="live-fallback-note">
          <Icon name="info" size={16} />
          {t`This browser doesn't support live video. The picture refreshes every 3 seconds.`}
        </p>
      ) : null}
      {live ? <StateChips cam={cam} admin={admin} /> : null}
      {body}
    </div>
  );
}

/** 從站內別頁（例如事件）進來就回那一頁，連同這頁自己多出來的回放紀錄一起退掉；直接開網址進來時回攝影機列表 */
function BackButton() {
  const { t } = useLingui();
  const router = useRouter();
  const entry = useRef(router.state.location.state.__TSR_index);
  const inApp = entry.current > 0;
  return (
    <Link
      to="/cameras"
      className="back-btn"
      aria-label={inApp ? t`Back` : t`Back to cameras`}
      onClick={(e) => {
        if (!inApp || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        router.history.go(entry.current - router.state.location.state.__TSR_index - 1);
      }}
    >
      <Icon name="left" />
    </Link>
  );
}

/** 沒有錄影可播（這台還沒錄過，或瀏覽器不能播）：只有即時畫面，時間軸的位置放一句說明 */
function LiveOnly({ cam, quality, admin, hasRecordings }: { cam: CameraDto; quality: Quality; admin: boolean; hasRecordings: boolean }) {
  const { t } = useLingui();
  const live = useLiveVideo(cam, quality, true);
  const [ptzSlot, setPtzSlot] = useState<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const { enabled, record } = cam.config;
  const off = !enabled || !record.enabled;
  return (
    <div className="pb-grid pb-live-only">
      <section className="card pb-player" aria-label={t`Player`}>
        <div className="pb-stage" ref={stageRef} data-view="live">
          <LiveFrame cam={cam} onTarget={live.onTarget} className="live-stage" />
          <LiveChip />
          <div className="ptz-ov" ref={setPtzSlot} />
        </div>
        {enabled ? <PtzPanel cam={cam} admin={admin} overlay={ptzSlot} /> : null}
        <div className="pb-controls">
          <div className="pb-actions">
            <LivePill />
            <button className="pb-ctl" type="button" aria-label={t`Full screen`} onClick={() => toggleFullscreen(stageRef.current, live.video())}>
              <Icon name="expand" size={18} />
            </button>
          </div>
        </div>
      </section>
      <div className="pb-timeline">
        {hasRecordings ? (
          <EmptyState
            title={t`This browser can't play recordings`}
            body={t`On iPhone, update to iOS 17.1 or later. You can also use Chrome, Edge, Firefox or Safari on a computer or Android.`}
            icon="alert"
          />
        ) : (
          <EmptyState
            title={t`This camera has no recordings yet`}
            body={!enabled ? t`This camera is disabled.` : record.enabled ? t`Once recording starts, you can play it back here within a few minutes.` : t`Continuous recording is off for this camera.`}
            action={
              admin && off ? (
                <ButtonLink to="/settings/cameras/$id" params={{ id: cam.id }} icon="edit">
                  {t`Turn on in camera settings`}
                </ButtonLink>
              ) : undefined
            }
          />
        )}
      </div>
    </div>
  );
}
