import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
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

/** 設定列上的一句話：「鐵捲門：開」「2 個感應器」「未設定」 */
export function statesSummary(sensors: StateSensorDto[] | undefined, now = Date.now()): string {
  if (!sensors) return t`Loading…`;
  if (sensors.length === 0) return t`Not set up`;
  if (sensors.length === 1) {
    const name = sensors[0]!.config.name;
    const state = stateText(sensorView(sensors[0]!), now);
    return t`${name}: ${state}`;
  }
  const names = sensors
    .map((s) => {
      const name = s.config.name;
      const state = stateText(sensorView(s), now).split(" · ")[0]!;
      return t`${name}: ${state}`;
    });
  return new Intl.ListFormat(i18n.locale, { style: "narrow", type: "unit" }).format(names);
}

/** 攝影機設定裡的「狀態辨識」：列出這台的感應器與目前狀態，點進去標記、訓練與調整；新增在另一頁 */
export function StatesSection({ camera }: { camera: CameraDto }) {
  const { t } = useLingui();
  const q = useQuery(statesQuery);
  const now = useNow();
  const sensors = sensorsOf(q.data, camera.id);
  return (
    <div className="set-block st-section">
      <p className="st-intro">
        <Trans>Tell what something in the picture looks like right now, such as whether a roller door is open or closed. Draw the area and label a few frames, and it learns on its own.</Trans>
      </p>
      {q.isError ? (
        <div className="callout bad">
          <Icon name="alert" size={16} />
          <p>{errMsg(q.error)}</p>
        </div>
      ) : null}
      {sensors.length ? (
        <ul className="st-list">
          {sensors.map((s) => {
            const pending = s.images.pending;
            return (
            <li key={s.id}>
              <Link className="st-row" to="/settings/cameras/$id/states/$sensorId" params={{ id: camera.id, sensorId: s.id }}>
                <span className="st-row-main">
                  <b>{s.config.name}</b>
                  <StateLine sensor={s} now={now} />
                </span>
                {jobActive(s) ? <span className="spin" aria-label={t`Working`} /> : null}
                {s.images.pending > 0 && s.model === null ? <span className="badge plain">{t`${pending} to label`}</span> : null}
                <Icon name="chevron" size={16} />
              </Link>
            </li>
            );
          })}
        </ul>
      ) : null}
      <div>
        <ButtonLink to="/settings/cameras/$id/states/new" params={{ id: camera.id }} small icon="plus" iconSize={15}>
          {sensors.length ? t`Add another` : t`Add state sensor`}
        </ButtonLink>
      </div>
    </div>
  );
}
