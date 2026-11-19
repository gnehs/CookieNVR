import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import type { CameraDto } from "../../../src/api-types.ts";
import { activeEventsQuery, camerasQuery } from "../../data/queries.ts";
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
      aria-label={[cam.config.name, st.quiet ? null : st.label, eventActive ? EVENT_ACTIVE.label : null].filter(Boolean).join("，")}
    >
      <LiveFrame cam={cam} onTarget={onTarget}>
        <span className="cam-status" hidden={st.quiet}>
          <i aria-hidden="true" />
          <span>{st.label}</span>
        </span>
      </LiveFrame>
      <span className="cam-name">
        <i className="cam-event-dot" aria-hidden="true" title={EVENT_ACTIVE.label} />
        <span className="cam-name-text">{cam.config.name}</span>
      </span>
    </Link>
  );
}

/** 首頁：所有攝影機的即時畫面。多宮格共用一條 `GET /api/live` 連線，啟用中的攝影機組合變了才重開 */
export function CamerasPage() {
  const isAdmin = useMe().role === "admin";
  const cams = useQuery(camerasQuery);
  const events = useQuery(activeEventsQuery).data ?? [];
  const health = useHealth(isAdmin);

  // 每格的 <video> 由 LiveFrame 登記進來；子元件的 effect 先跑，下面開連線時已經齊了
  const targets = useRef(new Map<string, LiveTarget>());
  const register = useCallback((id: string, t: LiveTarget | null) => {
    if (t) targets.current.set(id, t);
    else targets.current.delete(id);
  }, []);
  const gridKey = (cams.data ?? []).filter((c) => c.config.enabled).map((c) => c.id).join(",");
  useEffect(() => {
    if (!gridKey) return;
    const ids = gridKey.split(",");
    const list = ids.map((id) => targets.current.get(id));
    if (list.some((t) => !t)) return;
    return playGrid(ids, "sd", list as LiveTarget[]);
  }, [gridKey]);

  const alertText = health ? alertSummary(health.issues) : null;
  const list = cams.data;

  return (
    <div>
      <header className="page-head">
        <h1>攝影機</h1>
        {isAdmin ? (
          <div className="page-actions">
            <ButtonLink to="/settings/cameras/new" icon="plus" iconSize={18} hidden={!list || list.length === 0}>
              新增攝影機
            </ButtonLink>
          </div>
        ) : null}
      </header>
      <Link className="home-alert" to="/settings/status" hidden={alertText === null} data-tone={health?.issues.some((i) => i.tone === "bad") ? "bad" : "warn"}>
        <i className="home-alert-dot" aria-hidden="true" />
        <span className="home-alert-text">{alertText}</span>
        <span className="home-alert-go">
          查看
          <Icon name="chevron" size={16} />
        </span>
      </Link>
      {liveSupported() ? null : (
        <p className="live-fallback-note">
          <Icon name="info" size={16} />
          這個瀏覽器不支援即時影像，畫面每 3 秒更新一次。
        </p>
      )}
      <div>
        {cams.isPending ? (
          <Spinner />
        ) : cams.isError ? (
          <ErrorBox error={cams.error} onRetry={() => void cams.refetch()} />
        ) : list!.length === 0 ? (
          <EmptyState
            title="還沒有攝影機"
            body={isAdmin ? "加入第一台攝影機，馬上就會開始錄影。" : "請管理員加入攝影機。"}
            icon="camera"
            action={
              isAdmin ? (
                <ButtonLink to="/settings/cameras/new" variant="primary" icon="plus" iconSize={18}>
                  新增攝影機
                </ButtonLink>
              ) : undefined
            }
          />
        ) : (
          <div className="cam-grid">
            {list!.map((c) => (
              <CameraTile key={c.id} cam={c} eventActive={events.some((e) => e.cameraId === c.id)} register={register} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
