import { queryOptions } from "@tanstack/react-query";
import { api } from "../../api.ts";

/** 第一次要等試跑完成（通常幾秒）；之後每幾秒更新「目前實際用哪張卡」 */
export const videoDevicesQuery = queryOptions({ queryKey: ["video-devices"], queryFn: api.videoDevices, refetchInterval: 5_000 });
