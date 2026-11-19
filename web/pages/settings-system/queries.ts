import { queryOptions } from "@tanstack/react-query";
import { api } from "../../api.ts";

const POLL_MS = 3_000;
/** 測速中進度條要跟得上 */
const POLL_BENCH_MS = 1_000;

/** 物件辨識的狀態、模型與測速；開著時每幾秒更新，測速中每秒一次（分頁在背景時自動暫停） */
export const objectsQuery = (watch: boolean) =>
  queryOptions({
    queryKey: ["objects"],
    queryFn: api.objects,
    refetchInterval: (q) => {
      if (!watch) return false;
      const d = q.state.data;
      return d?.benchmark?.state === "running" || d?.status.paused === "benchmark" ? POLL_BENCH_MS : POLL_MS;
    },
  });

/** 第一次要等試跑完成（通常幾秒）；之後每幾秒更新「目前實際用哪張卡」 */
export const videoDevicesQuery = queryOptions({ queryKey: ["video-devices"], queryFn: api.videoDevices, refetchInterval: 5_000 });
