import type { EventDto } from "../api-types.ts";

/** HomeKit's motion sensor per camera: detected while the camera has an event in progress. */
export function motionByCamera(active: Pick<EventDto, "cameraId" | "endMs">[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const e of active) if (e.endMs === null) out.set(e.cameraId, true);
  return out;
}
