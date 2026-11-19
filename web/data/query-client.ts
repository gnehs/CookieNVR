import { MutationCache, QueryClient } from "@tanstack/react-query";
import { errMsg } from "../format.ts";
import { toast } from "../ui/toast.tsx";

/**
 * 查詢不自動重試、切回分頁不自動重抓（即時資料靠 SSE，其他頁面自己決定 refetchInterval）。
 * 變更（mutation）失敗時，沒有自己處理錯誤的就跳出錯誤通知。
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) => {
        if (!mutation.options.onError) toast(errMsg(error), "error");
      },
    }),
  });
}
