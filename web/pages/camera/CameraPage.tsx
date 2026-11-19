import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CameraDto } from "../../../src/api-types.ts";
import { camerasQuery } from "../../data/queries.ts";
import { useMe } from "../../data/session.ts";
import { cameraStatus } from "../../health.ts";
import { LiveFrame } from "../../live/LiveFrame.tsx";
import { playSingle, type LiveTarget, type Quality } from "../../live/transport.ts";
import { liveSupported } from "../../live/video.ts";
import { ButtonLink } from "../../ui/Button.tsx";
import { Segmented } from "../../ui/controls.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Badge } from "../../ui/Panel.tsx";
import { EmptyState, ErrorBox, Spinner } from "../../ui/states.tsx";
import { PtzPanel } from "./PtzPanel.tsx";
import { StateChips } from "./StateChips.tsx";

const QUALITY_KEY = "cookienvr.liveQuality";

function savedQuality(): Quality {
  try {
    return localStorage.getItem(QUALITY_KEY) === "hd" ? "hd" : "sd";
  } catch {
    return "sd";
  }
}

function saveQuality(q: Quality): void {
  try {
    localStorage.setItem(QUALITY_KEY, q);
  } catch {}
}

function NotFound() {
  return (
    <EmptyState
      icon="camera"
      title="找不到這台攝影機"
      body="可能已經被刪除了。"
      action={
        <ButtonLink to="/cameras" icon="left">
          回到攝影機
        </ButtonLink>
      }
    />
  );
}

/** 單台即時畫面：大畫面、畫質切換、去看這台的回放；其他細節不在這裡 */
export function CameraPage() {
  const { id } = useParams({ from: "/_authed/_shell/cameras/$id" });
  const cams = useQuery(camerasQuery);
  if (cams.isPending) return <Spinner />;
  if (cams.isError) return <ErrorBox error={cams.error} onRetry={() => void cams.refetch()} />;
  const cam = cams.data.find((c) => c.id === id);
  if (!cam) return <NotFound />;
  return <Live key={id} cam={cam} />;
}

function Live({ cam }: { cam: CameraDto }) {
  const isAdmin = useMe().role === "admin";
  const [quality, setQuality] = useState<Quality>(savedQuality);
  const target = useRef<LiveTarget | null>(null);
  const onTarget = useCallback((t: LiveTarget | null) => {
    target.current = t;
  }, []);
  const enabled = cam.config.enabled;
  const id = cam.id;
  // 子元件的 effect 先跑，這裡拿得到 <video>；啟用狀態或畫質變了才重開
  useEffect(() => {
    if (!enabled || !target.current) return;
    return playSingle(id, quality, target.current);
  }, [id, enabled, quality]);

  const st = cameraStatus(cam);
  return (
    <div className="live-page">
      <header className="page-head sub-head live-head">
        <Link to="/cameras" className="back-btn" aria-label="回到攝影機">
          <Icon name="left" />
        </Link>
        <div className="live-title">
          <h1>{cam.config.name}</h1>
          <span className="live-pill">{st.quiet ? null : <Badge kind={st.tone}>{st.label}</Badge>}</span>
        </div>
        <div className="page-actions">
          {enabled ? (
            <Segmented
              label="畫質"
              options={[
                { value: "sd", label: "標準" },
                { value: "hd", label: "高畫質" },
              ]}
              value={quality}
              onChange={(q) => {
                setQuality(q);
                saveQuality(q);
              }}
            />
          ) : null}
          <ButtonLink to="/recordings" search={{ camera: id }} variant="primary" icon="film">
            看回放
          </ButtonLink>
        </div>
      </header>
      <LivePtzBody cam={cam} isAdmin={isAdmin} onTarget={onTarget} />
      <StateChips cam={cam} admin={isAdmin} />
      {liveSupported() ? null : (
        <p className="live-fallback-note below">
          <Icon name="info" size={16} />
          這個瀏覽器不支援即時影像，畫面每 3 秒更新一次。
        </p>
      )}
    </div>
  );
}

function LivePtzBody({ cam, isAdmin, onTarget }: { cam: CameraDto; isAdmin: boolean; onTarget: (t: LiveTarget | null) => void }) {
  // PtzPanel 回報有沒有面板，外層的 data-ptz 決定版面（左右分欄）
  const [mode, setMode] = useState<"panel" | "note" | undefined>();
  return (
    <div className="live-body" data-ptz={mode}>
      <LiveFrame cam={cam} onTarget={onTarget} className="live-stage" />
      {cam.config.enabled ? <PtzPanel cam={cam} admin={isAdmin} onMode={setMode} /> : null}
    </div>
  );
}
