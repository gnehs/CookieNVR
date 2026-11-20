import { useLingui } from "@lingui/react/macro";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { camerasQuery } from "../../data/queries.ts";
import { useMe } from "../../data/session.ts";
import { Player } from "../../playback/player.ts";
import { ButtonLink } from "../../ui/Button.tsx";
import { parseDayKey, type DayKey } from "../../ui/date-logic.ts";
import { Select } from "../../ui/Select.tsx";
import { EmptyState, ErrorBox, Spinner } from "../../ui/states.tsx";
import { Playback } from "./Playback.tsx";
import { daysQuery } from "./queries.ts";

/**
 * 網址參數（事件頁與單台攝影機頁的連結也用這組）：
 * camera 攝影機 id；date 瀏覽器時區的日子 YYYY-MM-DD；t 從這個時間點（epoch 毫秒）開始播。
 * 都可以省略：攝影機預設第一台、日期預設最近有錄影的一天、時間預設今天最新或那天第一段。
 */
export interface RecordingsSearch {
  camera?: string;
  date?: DayKey;
  t?: number;
}

export function parseRecordingsSearch(s: Record<string, unknown>): RecordingsSearch {
  const out: RecordingsSearch = {};
  // 純數字的 id 會被當成數字解析回來
  if ((typeof s.camera === "string" && s.camera) || typeof s.camera === "number") out.camera = String(s.camera);
  const date = parseDayKey(typeof s.date === "string" ? s.date : null);
  if (date) out.date = date;
  const t = Number(s.t);
  if (s.t !== undefined && s.t !== null && Number.isFinite(t) && t > 0) out.t = Math.round(t);
  return out;
}

const route = getRouteApi("/_authed/_shell/recordings");

export function RecordingsPage() {
  const { t } = useLingui();
  const admin = useMe().role === "admin";
  const navigate = useNavigate();
  const wanted = route.useSearch({ select: (s) => s.camera });
  const wantedDate = route.useSearch({ select: (s) => s.date });
  const cams = useQuery(camerasQuery);
  const cam = cams.data?.find((c) => c.id === wanted) ?? cams.data?.[0];
  // 換攝影機時先留著上一台的日子，播放器不用因為等資料而拆掉重建
  const daysQ = useQuery({ ...daysQuery(cam?.id ?? ""), enabled: !!cam, placeholderData: keepPreviousData });

  if (cams.isPending) return <Spinner />;
  if (cams.isError) return <ErrorBox error={cams.error} onRetry={() => void cams.refetch()} />;
  if (!cam) {
    return (
      <div>
        <header className="page-head">
          <h1>{t`Recordings`}</h1>
        </header>
        <EmptyState
          title={t`No cameras yet`}
          body={admin ? t`Once you add a camera it starts recording, and the footage shows up here.` : t`Ask an admin to add a camera. The footage will show up here.`}
          icon="camera"
          action={
            admin ? (
              <ButtonLink to="/settings/cameras/new" variant="primary" icon="plus" iconSize={18}>
                {t`Add camera`}
              </ButtonLink>
            ) : undefined
          }
        />
      </div>
    );
  }

  const camPick = (
    <Select
      label={t`Camera`}
      icon="camera"
      className="pb-cam"
      entries={cams.data.map((c) => ({ value: c.id, label: c.config.name }))}
      value={cam.id}
      onChange={(id) => void navigate({ to: "/recordings", search: { camera: id } })}
    />
  );
  const head = (
    <header className="page-head">
      <h1>{t`Recordings`}</h1>
      {camPick}
    </header>
  );

  if (daysQ.isPending) return <Spinner />;
  if (daysQ.isError) return <ErrorBox error={daysQ.error} onRetry={() => void daysQ.refetch()} />;
  const days = daysQ.data;
  const daysReady = !daysQ.isPlaceholderData;
  if (daysReady && days.length === 0) {
    const off = !cam.config.enabled || !cam.config.record.enabled;
    return (
      <div>
        {head}
        <EmptyState
          title={t`This camera has no recordings yet`}
          body={!cam.config.enabled ? t`This camera is disabled.` : cam.config.record.enabled ? t`Once recording starts, you can play it back here within a few minutes.` : t`Continuous recording is off for this camera.`}
          action={
            admin && off ? (
              <ButtonLink to="/settings/cameras/$id" params={{ id: cam.id }} icon="edit">
                {t`Turn on in camera settings`}
              </ButtonLink>
            ) : undefined
          }
        />
      </div>
    );
  }
  if (!Player.supported()) {
    return (
      <div>
        {head}
        <EmptyState
          title={t`This browser can't play recordings`}
          body={t`On iPhone, update to iOS 17.1 or later. You can also use Chrome, Edge, Firefox or Safari on a computer or Android.`}
          icon="alert"
        />
      </div>
    );
  }
  // 換攝影機的瞬間 days 還是上一台的（daysReady 為 false），Playback 這時不載入也不跳轉
  const date = wantedDate && days.includes(wantedDate) ? wantedDate : days[days.length - 1];
  if (!date) return <Spinner />;
  return <Playback cam={cam} days={days} daysReady={daysReady} date={date} camPick={camPick} />;
}
