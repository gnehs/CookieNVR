import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import type { CameraDto } from "../../../src/api-types.ts";
import { sectionsOf } from "../../camera-layout.ts";
import { activeEventsQuery, cameraGroupsQuery, camerasQuery } from "../../data/queries.ts";
import { useMe } from "../../data/session.ts";
import { useHealth } from "../../data/use-health.ts";
import { alertSummary, cameraStatus, EVENT_ACTIVE } from "../../health.ts";
import { LiveFrame } from "../../live/LiveFrame.tsx";
import { playGrid, type LiveTarget } from "../../live/transport.ts";
import { liveSupported } from "../../live/video.ts";
import { ButtonLink } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { EmptyState, ErrorBox, Spinner } from "../../ui/states.tsx";

function CameraTile({ cam, eventActive, register }: { cam: CameraDto; eventActive: boolean; register: (id: string, t: LiveTarget | null) => void }) {
  const st = cameraStatus(cam);
  const onTarget = useCallback((t: LiveTarget | null) => register(cam.id, t), [register, cam.id]);
  return (
    <Link
      className="cam-tile"
      to="/cameras/$id"
      params={{ id: cam.id }}
      data-status={st.kind}
      data-tone={st.tone}
      data-event={eventActive ? "" : undefined}
      title={cam.config.name}
      aria-label={[st.quiet ? null : st.label, cam.config.name, eventActive ? EVENT_ACTIVE.label : null].filter(Boolean).join(" ")}
    >
      <LiveFrame cam={cam} onTarget={onTarget} />
      {/* 狀態放在名稱這一列的右邊，不蓋到畫面 */}
      <span className="cam-name">
        <i className="cam-event-dot" aria-hidden="true" title={EVENT_ACTIVE.label} />
        <span className="cam-name-text">{cam.config.name}</span>
        <span className="cam-status" hidden={st.quiet}>
          <i aria-hidden="true" />
          <span>{st.label}</span>
        </span>
      </span>
    </Link>
  );
}

/** 首頁：所有攝影機的即時畫面。多宮格共用一條 `GET /api/live` 連線，啟用中的攝影機組合變了才重開 */
export function CamerasPage() {
  const { t } = useLingui();
  const isAdmin = useMe().role === "admin";
  const cams = useQuery(camerasQuery);
  const groups = useQuery(cameraGroupsQuery).data ?? [];
  const events = useQuery(activeEventsQuery).data ?? [];
  const health = useHealth(isAdmin);

  // 每格的 <video> 由 LiveFrame 登記進來；子元件的 effect 先跑，下面開連線時已經齊了
  const targets = useRef(new Map<string, LiveTarget>());
  const register = useCallback((id: string, target: LiveTarget | null) => {
    if (target) targets.current.set(id, target);
    else targets.current.delete(id);
  }, []);
  const gridKey = (cams.data ?? []).filter((c) => c.config.enabled).map((c) => c.id).join(",");
  useEffect(() => {
    if (!gridKey) return;
    const ids = gridKey.split(",");
    const list = ids.map((id) => targets.current.get(id));
    if (list.some((target) => !target)) return;
    return playGrid(ids, "sd", list as LiveTarget[]);
  }, [gridKey]);

  const alertText = health ? alertSummary(health.issues) : null;
  const list = cams.data;

  return (
    <div>
      <header className="page-head">
        <h1>{t`Cameras`}</h1>
        {isAdmin ? (
          <div className="page-actions">
            <ButtonLink to="/settings/cameras/new" icon="plus" iconSize={18} hidden={!list || list.length === 0}>
              {t`Add camera`}
            </ButtonLink>
          </div>
        ) : null}
      </header>
      <Link className="home-alert" to="/settings/status" hidden={alertText === null} data-tone={health?.issues.some((i) => i.tone === "bad") ? "bad" : "warn"}>
        <i className="home-alert-dot" aria-hidden="true" />
        <span className="home-alert-text">{alertText}</span>
        <span className="home-alert-go">
          {t`View`}
          <Icon name="chevron" size={16} />
        </span>
      </Link>
      {liveSupported() ? null : (
        <p className="live-fallback-note">
          <Icon name="info" size={16} />
          {t`This browser doesn't support live video. The picture refreshes every 3 seconds.`}
        </p>
      )}
      <div>
        {cams.isPending ? (
          <Spinner />
        ) : cams.isError ? (
          <ErrorBox error={cams.error} onRetry={() => void cams.refetch()} />
        ) : list!.length === 0 ? (
          <EmptyState
            title={t`No cameras yet`}
            body={isAdmin ? t`Add your first camera and it starts recording right away.` : t`Ask an admin to add a camera.`}
            icon="camera"
            action={
              isAdmin ? (
                <ButtonLink to="/settings/cameras/new" variant="primary" icon="plus" iconSize={18}>
                  {t`Add camera`}
                </ButtonLink>
              ) : undefined
            }
          />
        ) : (
          <div className="cam-sections">
            {/* 沒有分區時只有一段、不放標題；空的分區在首頁不顯示 */}
            {sectionsOf(list!, groups)
              .filter((s) => s.cameras.length > 0)
              .map((s) => (
                <section key={s.group?.id ?? "ungrouped"} className="cam-section" aria-label={groups.length ? (s.group?.name ?? t`Ungrouped`) : undefined}>
                  {groups.length ? (
                    <h2 className="cam-section-title">
                      {s.group?.name ?? t`Ungrouped`}
                      <span className="cam-section-count num">{s.cameras.length}</span>
                    </h2>
                  ) : null}
                  <div className="cam-grid">
                    {s.cameras.map((c) => (
                      <CameraTile key={c.id} cam={c} eventActive={events.some((e) => e.cameraId === c.id)} register={register} />
                    ))}
                  </div>
                </section>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
