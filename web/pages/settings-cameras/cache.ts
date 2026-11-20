import type { QueryClient } from "@tanstack/react-query";
import type { CameraDto } from "../../../src/api-types.ts";
import { camerasQuery } from "../../data/queries.ts";

/** 存檔後馬上換掉快取裡的這台（SSE 之後也會推同樣的內容），首頁、側欄與清單不用等 */
export function putCamera(qc: QueryClient, cam: CameraDto): void {
  qc.setQueryData(camerasQuery.queryKey, (list) => (!list ? list : list.some((c) => c.id === cam.id) ? list.map((c) => (c.id === cam.id ? cam : c)) : [...list, cam]));
}
