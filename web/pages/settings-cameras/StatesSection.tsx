import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CameraDto, StateSensorDto } from "../../../src/api-types.ts";
import { errMsg } from "../../format.ts";
import { StateLine, useNow } from "../../states/bits.tsx";
import { jobActive, sensorView, stateText } from "../../states/model.ts";
import { statesQuery } from "../../states/queries.ts";
import { ButtonLink } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";

export const sensorsOf = (list: StateSensorDto[] | undefined, cameraId: string) => (list ?? []).filter((s) => s.cameraId === cameraId);

/** 收合的卡片上的一句話：「鐵捲門：開」「2 個感應器」「未設定」 */
export function statesSummary(sensors: StateSensorDto[] | undefined, now = Date.now()): string {
  if (!sensors) return "正在讀取…";
  if (sensors.length === 0) return "未設定";
  if (sensors.length === 1) return `${sensors[0]!.config.name}：${stateText(sensorView(sensors[0]!), now)}`;
  return sensors.map((s) => `${s.config.name}：${stateText(sensorView(s), now).split(" · ")[0]}`).join("、");
}

/** 攝影機表單裡的「狀態辨識」：列出這台的感應器與目前狀態，點進去標記、訓練與調整；新增在另一頁 */
export function StatesSection({ camera }: { camera: CameraDto }) {
  const q = useQuery(statesQuery);
  const now = useNow();
  const sensors = sensorsOf(q.data, camera.id);
  return (
    <div className="set-block st-section">
      <p className="st-intro">判斷畫面上某個東西目前的樣子，例如鐵捲門是開還是關。框出區域、標記幾張畫面，就會自己學會。</p>
      {q.isError ? (
        <div className="callout bad">
          <Icon name="alert" size={16} />
          <p>{errMsg(q.error)}</p>
        </div>
      ) : null}
      {sensors.length ? (
        <ul className="st-list">
          {sensors.map((s) => (
            <li key={s.id}>
              <Link className="st-row" to="/settings/cameras/$id/states/$sensorId" params={{ id: camera.id, sensorId: s.id }}>
                <span className="st-row-main">
                  <b>{s.config.name}</b>
                  <StateLine sensor={s} now={now} />
                </span>
                {jobActive(s) ? <span className="spin" aria-label="處理中" /> : null}
                {s.images.pending > 0 && s.model === null ? <span className="badge plain">{s.images.pending} 張待標記</span> : null}
                <Icon name="chevron" size={16} />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <div>
        <ButtonLink to="/settings/cameras/$id/states/new" params={{ id: camera.id }} small icon="plus" iconSize={15}>
          {sensors.length ? "再加一個" : "新增狀態感應器"}
        </ButtonLink>
      </div>
    </div>
  );
}
