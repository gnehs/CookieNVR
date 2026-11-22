import { MutationCache, QueryClient } from "@tanstack/react-query";
import { errMsg } from "../format.ts";
import { toast } from "../ui/toast.tsx";

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: {
      /** 這個 mutation 自己把錯誤顯示在畫面上（欄位旁、對話框裡），不要再跳全域的錯誤通知 */
      handlesError?: true;
    };
  }
}

/**
 * 查詢不自動重試、切回分頁不自動重抓（即時資料靠 SSE，其他頁面自己決定 refetchInterval）。
 * 變更（mutation）失敗時跳出錯誤通知；`meta: { handlesError: true }` 的由呼叫端自己顯示。
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) => {
        if (!mutation.meta?.handlesError) toast(errMsg(error), "error");
      },
    }),
  });
}
