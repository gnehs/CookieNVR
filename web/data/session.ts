import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import type { MeDto } from "../../src/api-types.ts";
import { api, ApiError } from "../api.ts";

export const infoQuery = queryOptions({ queryKey: ["info"], queryFn: api.info, staleTime: Infinity });

/** 目前登入的使用者；沒登入是 null（不是錯誤） */
export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async (): Promise<MeDto | null> => {
    try {
      return await api.me(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
  staleTime: Infinity,
});

/** 登入後要回去的頁面；只接受站內路徑，避免 `next` 被拿來導到別的網站 */
export function safeNext(next: unknown): string | null {
  return typeof next === "string" && /^\/[a-z]/i.test(next) ? next : null;
}

/** 登出或登入失效：只留站台資訊，其他快取（含即時狀態）全部丟掉，下一個登入的人不會看到上一個人的資料 */
export function forgetSession(qc: QueryClient): void {
  qc.setQueryData(meQuery.queryKey, null);
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "info" && q.queryKey[0] !== "me" });
}

export async function logout(): Promise<void> {
  await api.logout().catch(() => {});
  // 整頁重新載入：即時影像、SSE 與所有快取一次清乾淨
  location.replace("/login");
}

/** 目前登入的使用者。只能用在 `_authed` 底下的頁面：那裡保證已經登入 */
export function useMe(): MeDto {
  const me = useQuery(meQuery).data;
  if (!me) throw new Error("useMe() 只能用在需要登入的頁面");
  return me;
}

/** 管理員專屬頁面的 beforeLoad：一般使用者導回首頁（跟舊版一樣，不顯示錯誤） */
export function requireAdmin({ context }: { context: { me: MeDto } }): void {
  if (context.me.role !== "admin") throw redirect({ to: "/cameras", replace: true });
}
