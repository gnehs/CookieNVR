import { plural, t } from "@lingui/core/macro";
import type { MetricsDto } from "../../../src/api-types.ts";
import { formatBytes, joinList } from "../../format.ts";
import type { Health, Issue } from "../../health.ts";
import type { IconName } from "../../ui/icons.ts";
import { categoryLabel } from "./ResourcesCard.tsx";

export type IssueTarget =
  | { to: "/settings/system" | "/settings/objects" | "/settings/storage" | "/settings/cameras" }
  | { to: "/settings/cameras/$id"; params: { id: string } }
  | { to: "/settings/cameras/$id/states/$sensorId"; params: { id: string; sensorId: string } };

export interface Restart {
  ids: string[];
  title: string;
  message: string;
  done: string;
}

export type Action = { label: string; restart: Restart } | ({ label: string } & IssueTarget);

export interface Explained {
  /** 這一列的主角：攝影機名稱或「影像服務」「儲存空間」 */
  who: string;
  pill: { label: string; tone: "bad" | "warn" };
  /** 一句下一步 */
  next: string;
  /** 較長的可能原因，收在「可能的原因」裡 */
  why: string;
  action?: Action;
}

export interface Snapshot {
  health: Health;
  metrics: MetricsDto | null;
}

/** 「目前最花處理器的是錄影」；還沒算出各類用量時是空字串 */
function topUser(snap: Snapshot, by: "cpuPct" | "memBytes"): string {
  const top = [...(snap.metrics?.usage ?? [])].sort((a, b) => b[by] - a[by])[0];
  if (!top || top[by] <= 0) return "";
  const category = categoryLabel(top.category);
  return t`The biggest user right now is “${category}”. `;
}

export const SYSTEM_ICON: Partial<Record<Issue["kind"], IconName>> = { restream: "server", objects: "server", objectsLoad: "server", decode: "server", stateWorker: "server", cpuBusy: "activity", memoryHigh: "activity" };

/** 每一類問題只寫一次：一句下一步、收起來的原因、一個最可能有用的動作 */
export function explain(issue: Issue, snap: Snapshot): Explained {
  const one = issue.cameras.length === 1;
  const names = joinList(issue.cameras.map((c) => c.name));
  const sensors = issue.sensors ?? [];
  const camOf = (id: string) => issue.cameras.find((c) => c.id === id)?.name ?? "";
  const sensorWho = joinList(
    sensors.map((s) => {
      const camera = camOf(s.cameraId);
      const sensor = s.name;
      return t`“${sensor}” on ${camera}`;
    }),
  );
  const sensorAction = (label: string): Action =>
    sensors.length === 1
      ? { label, to: "/settings/cameras/$id/states/$sensorId", params: { id: sensors[0]!.cameraId, sensorId: sensors[0]!.id } }
      : issue.cameras.length === 1
        ? { label, to: "/settings/cameras/$id", params: { id: issue.cameras[0]!.id } }
        : { label, to: "/settings/cameras" };
  const restartLabel = t`Restart`;
  const checkSettings = t`Check settings`;
  const adjustSettings = t`Adjust settings`;
  const adjustRetention = t`Adjust retention`;
  const lowSpace = t`Low on space`;
  const almostFull = t`Almost full`;
  const stopped = t`Stopped`;
  switch (issue.kind) {
    case "stateUntrained":
      return {
        who: sensorWho,
        pill: { label: t`Not trained yet`, tone: "warn" },
        next: t`Label each class of picture, then press “Start training”`,
        why: t`A state sensor has to see each look first (for example, a door open and a door closed) before it can tell them apart. Once you have labeled the pictures, training takes only a few seconds to a few dozen seconds. If you no longer need it, you can also just delete it.`,
        action: sensorAction(t`Go label`),
      };
    case "stateStale":
      return {
        who: sensorWho,
        pill: { label: t`Needs retraining`, tone: "warn" },
        next: t`The classes changed. It will keep recognizing after you retrain it`,
        why: t`After you add or delete a class, what was learned before no longer matches the new classes, so recognition is paused. Label a few pictures for each new class, then press “Retrain”.`,
        action: sensorAction(t`Retrain`),
      };
    case "stateNoFrames":
      return {
        who: sensorWho,
        pill: { label: t`Can't see the picture`, tone: "warn" },
        next: t`The camera is connected, but state recognition isn't receiving any picture`,
        why: t`State recognition uses the same picture as motion detection. When this camera's detection picture is interrupted, it can't tell the state. Check that “Detection” is turned on in the camera settings. If it still doesn't work, use “Copy diagnostics” at the bottom of the page to find the cause.`,
        action: issue.cameras.length === 1 ? { label: checkSettings, to: "/settings/cameras/$id", params: { id: issue.cameras[0]!.id } } : { label: checkSettings, to: "/settings/cameras" },
      };
    case "stateWorker":
      return {
        who: t`State recognition`,
        pill: { label: stopped, tone: "warn" },
        next: issue.detail ?? t`Restart it and it usually recovers`,
        why: t`The process that judges the state of the picture isn't running, so every state sensor stays at “Unknown”. Recording and motion detection are not affected. Right after boot it takes a moment to start. If it doesn't recover, restart it. If that still doesn't help, use “Copy diagnostics” at the bottom of the page to find the cause.`,
        action: { label: restartLabel, restart: { ids: ["classifier"], title: t`Restart state recognition?`, message: t`States will become unknown first and be checked again after a few seconds. Recording is not affected.`, done: t`State recognition restarted` } },
      };
    case "restream":
      if (issue.detail)
        return {
          who: t`Video service`,
          pill: { label: t`Port in use`, tone: "bad" },
          next: issue.detail,
          why: t`Usually another surveillance program is running on the same host (for example Frigate or go2rtc, which also use 8554). When the container uses Host networking, set the environment variable RTSP_PORT to a port nobody uses. With bridge networking, set RTSP_PORT and the host-side and container-side ports to the same number. Restart the container afterwards.`,
        };
      return {
        who: t`Video service`,
        pill: { label: stopped, tone: "bad" },
        next: t`Restart it to bring back the picture and recording`,
        why: t`Every camera's picture goes through this service, so when it stops, the picture and recording are interrupted. A restart interrupts them for a few seconds.`,
        action: { label: restartLabel, restart: { ids: ["restream"], title: t`Restart the video service?`, message: t`The picture and recording of every camera will be interrupted for a few seconds.`, done: t`Video service restarted` } },
      };
    case "objects":
      return {
        who: t`Object detection`,
        pill: { label: stopped, tone: "warn" },
        next: t`Restart it and detection usually recovers`,
        why: t`While object detection is stopped, recording and motion detection are not affected, but events won't be tagged with what was seen. Cameras set to “Filter” create events from ordinary motion instead. If it is still stopped after a restart, use “Copy diagnostics” at the bottom of the page to find the cause, or go to “Settings → Object detection” to switch the model or inference device.`,
        action: { label: restartLabel, restart: { ids: ["detector"], title: t`Restart object detection?`, message: t`Detection will be interrupted for a few seconds. Recording is not affected.`, done: t`Object detection restarted` } },
      };
    case "objectsLoad":
      return {
        who: t`Object detection`,
        pill: { label: t`Can't keep up`, tone: "warn" },
        next: issue.title,
        why: t`When detection can't keep up, the extra frames are skipped. Recording and motion detection are not affected, but events may miss what was seen. Lowering the detection rate, using a faster device, or running the speed test in settings to see what this machine can do will all help.`,
        action: { label: adjustSettings, to: "/settings/objects" },
      };
    case "decode":
      return {
        who: t`Video decoding`,
        pill: { label: t`Using the CPU`, tone: "warn" },
        next: issue.detail ?? issue.title,
        why: t`When the graphics card can't decode, video is decoded by the CPU instead. Recording and motion detection still work, but the CPU does some extra work. You can pick another graphics card or switch back to automatic in “Settings → General”. The reason is written in “Copy diagnostics”.`,
        action: { label: adjustSettings, to: "/settings/system" },
      };
    case "offline":
      return {
        who: names,
        pill: { label: t`Can't connect`, tone: "bad" },
        next: t`Make sure the camera is on and connected to the network`,
        why: t`No picture is coming in, so nothing can be recorded either. Common causes are the camera losing power, Wi-Fi dropping, or the IP address changing. If you changed routers recently, update the IP in the camera settings. A camera can only serve a few stream connections at once. If other software such as Frigate also connects to this camera directly, the slots can run out, so point them at CookieNVR's stream URL instead.`,
        action: one ? { label: checkSettings, to: "/settings/cameras/$id", params: { id: issue.cameras[0]!.id } } : { label: checkSettings, to: "/settings/cameras" },
      };
    case "notRecording":
      if (issue.detail)
        return {
          who: names,
          pill: { label: t`No write permission`, tone: "bad" },
          next: t`Recording can't be written to storage. Restarting the container usually fixes it`,
          why: t`CookieNVR runs as the user set by PUID/PGID, but the recording folder contains folders it can't write to, usually created earlier when it ran as root (PUID not set). Restarting the container hands the folders to this user automatically. If it still doesn't work, give the recording and appdata folders to PUID:PGID on the host (for example chown -R 99:100 <path on the host>), then restart the container.`,
        };
      const cameraName = issue.cameras[0]?.name ?? "";
      return {
        who: names,
        pill: { label: t`Not recording`, tone: "bad" },
        next: t`Start recording again and it usually recovers`,
        why: t`The picture is fine, but recording won't start. Common causes are low storage space or being unable to write to the storage location. If it still isn't recording after starting again, use “Copy diagnostics” at the bottom of the page to find the cause.`,
        action: {
          label: t`Start again`,
          restart: {
            ids: issue.cameras.map((c) => `record:${c.id}`),
            title: one ? t`Restart recording for “${cameraName}”?` : restartRecordingTitle(issue.cameras.length),
            message: t`Recording will be interrupted for a few seconds.`,
            done: t`Recording restarted`,
          },
        },
      };
    case "unstable":
      return {
        who: names,
        pill: { label: t`Recording unstable`, tone: "warn" },
        next: t`Move the camera closer to the router or use a wired connection`,
        why: t`In the last 10 minutes recording was interrupted and recovered on its own many times. A common cause is an unstable network signal.`,
      };
    case "diskLow": {
      const free = formatBytes(snap.health.disk.free);
      return {
        who: t`Storage`,
        pill: { label: lowSpace, tone: "bad" },
        next: t`Shorten the retention period or get a bigger disk`,
        why: t`Only ${free} is left, below the minimum free space you set, and the system is deleting the oldest recordings to free up space.`,
        action: { label: adjustRetention, to: "/settings/storage" },
      };
    }
    case "diskFull": {
      const used = snap.health.disk.usedPct.toFixed(0);
      return {
        who: t`Storage`,
        pill: { label: almostFull, tone: "warn" },
        next: t`You can shorten the retention period first`,
        why: t`${used}% is used. The oldest recordings are deleted automatically before space runs out, and a shorter retention period keeps important clips from being deleted.`,
        action: { label: adjustRetention, to: "/settings/storage" },
      };
    }
    case "dataDiskLow": {
      const free = formatBytes(snap.health.dataDisk?.free ?? 0);
      return {
        who: t`appdata disk`,
        pill: issue.tone === "bad" ? { label: lowSpace, tone: "bad" } : { label: almostFull, tone: "warn" },
        next: t`Free up space on the appdata disk`,
        why: t`The database, event thumbnails and exported videos live on this disk, and only ${free} is left. Nothing here is cleaned up automatically. When the space runs out, exports fail and events and settings may not be saved. Delete other files on the same disk that you don't need (for example data from other containers), or move /data to a larger disk.`,
      };
    }
    case "cpuBusy": {
      const topCpu = topUser(snap, "cpuPct");
      return {
        who: t`CPU`,
        pill: { label: t`Busy for a long time`, tone: "warn" },
        next: t`Reduce the work running at once, or move to a more powerful machine`,
        why: t`For the past 5 minutes the CPU has been above 90% almost the whole time, so video may lag and recording may drop frames. ${topCpu} You can turn off motion detection you don't need, open fewer live views, or have cameras detect on a lower-resolution substream.`,
      };
    }
    case "memoryHigh": {
      const topMem = topUser(snap, "memBytes");
      return {
        who: t`Memory`,
        pill: { label: t`Running low`, tone: "warn" },
        next: t`Reduce what the cameras are doing, or add memory`,
        why: t`For the past 5 minutes memory has been above 90% almost the whole time. When it runs out, the system force-quits programs and recording may be interrupted. ${topMem} If CookieNVR runs in Docker with a memory limit, you can raise the limit.`,
      };
    }
  }
}

function restartRecordingTitle(count: number): string {
  return plural(count, { one: "Restart recording for # camera?", other: "Restart recording for # cameras?" });
}
