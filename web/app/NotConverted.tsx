import { EmptyState } from "../ui/states.tsx";

/** 還沒轉成 React 的頁面。轉換時把路由檔的 component 換成新頁面，這個佔位就不再被用到 */
export function NotConverted({ title, legacy }: { title: string; legacy: string }) {
  return <EmptyState icon="info" title={`「${title}」還在搬家`} body={`這一頁正在改寫成新版介面（舊版：${legacy}）。`} />;
}
