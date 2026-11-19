import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CameraDto } from "../../../src/api-types.ts";
import { StateLine, useNow } from "../../states/bits.tsx";
import { statesQuery } from "../../states/queries.ts";

/** 單台頁畫面下方：這台每個已訓練的狀態感應器現在是什麼樣子，例如「鐵捲門：開 · 12 分鐘前」 */
export function StateChips({ cam, admin }: { cam: CameraDto; admin: boolean }) {
  const sensors = useQuery({ ...statesQuery, select: (list) => list.filter((s) => s.cameraId === cam.id && s.model !== null && s.config.enabled) }).data ?? [];
  const now = useNow();
  if (!sensors.length) return null;
  return (
    <ul className="st-chips" aria-label="狀態">
      {sensors.map((s) => (
        <li key={s.id}>
          {admin ? (
            <Link className="st-chip" to="/settings/cameras/$id/states/$sensorId" params={{ id: cam.id, sensorId: s.id }}>
              <StateLine sensor={s} now={now} withName />
            </Link>
          ) : (
            <span className="st-chip">
              <StateLine sensor={s} now={now} withName />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
