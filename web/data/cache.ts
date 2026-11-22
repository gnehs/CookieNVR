import type { DataTag, QueryClient, QueryKey } from "@tanstack/react-query";

type HasId = { id: string | number };

/** 清單裡有同 id 的就換掉，沒有就加在最後 */
export function upsert<T extends HasId>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  return i < 0 ? [...list, item] : list.map((x, j) => (j === i ? item : x));
}

export function without<T extends HasId>(list: T[], id: T["id"]): T[] {
  return list.filter((x) => x.id !== id);
}

type ListQuery<T> = { queryKey: DataTag<QueryKey, T[], Error> };

/** 把一筆資料寫進快取裡的清單（例如存檔後馬上換掉那台攝影機）；清單還沒載入過就不動，第一次抓會拿到完整的 */
export function putItem<T extends HasId>(qc: QueryClient, query: ListQuery<T>, item: T): void {
  qc.setQueryData(query.queryKey, (list) => list && upsert(list, item));
}

/** 把一筆資料從快取裡的清單拿掉 */
export function dropItem<T extends HasId>(qc: QueryClient, query: ListQuery<T>, id: T["id"]): void {
  qc.setQueryData(query.queryKey, (list) => list && without(list, id));
}
