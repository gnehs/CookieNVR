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
          <h1>錄影</h1>
        </header>
        <EmptyState
          title="還沒有攝影機"
          body={admin ? "加入攝影機後就會開始錄影，錄好的影片會出現在這裡。" : "請管理員加入攝影機，錄好的影片會出現在這裡。"}
          icon="camera"
          action={
            admin ? (
              <ButtonLink to="/settings/cameras/new" variant="primary" icon="plus" iconSize={18}>
                新增攝影機
              </ButtonLink>
            ) : undefined
          }
        />
      </div>
    );
  }

  const camPick = (
    <Select
      label="攝影機"
      icon="camera"
      className="pb-cam"
      entries={cams.data.map((c) => ({ value: c.id, label: c.config.name }))}
      value={cam.id}
      onChange={(id) => void navigate({ to: "/recordings", search: { camera: id } })}
    />
  );
  const head = (
    <header className="page-head">
      <h1>錄影</h1>
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
          title="這台攝影機還沒有錄影"
          body={!cam.config.enabled ? "這台攝影機已停用。" : cam.config.record.enabled ? "錄影開始後，幾分鐘內就能在這裡回放。" : "這台攝影機沒有開啟全天候錄影。"}
          action={
            admin && off ? (
              <ButtonLink to="/settings/cameras/$id" params={{ id: cam.id }} icon="edit">
                到攝影機設定開啟
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
        <EmptyState title="這個瀏覽器無法播放錄影" body="iPhone 請更新到 iOS 17.1 以上；也可以改用電腦或 Android 上的 Chrome、Edge、Firefox 或 Safari。" icon="alert" />
      </div>
    );
  }
  // 換攝影機的瞬間 days 還是上一台的（daysReady 為 false），Playback 這時不載入也不跳轉
  const date = wantedDate && days.includes(wantedDate) ? wantedDate : days[days.length - 1];
  if (!date) return <Spinner />;
  return <Playback cam={cam} days={days} daysReady={daysReady} date={date} camPick={camPick} />;
}
