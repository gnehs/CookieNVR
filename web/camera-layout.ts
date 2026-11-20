import type { CameraDto, CameraGroupDto, CameraLayoutDto } from "../src/api-types.ts";
import type { CameraId, GroupId } from "../src/types.ts";

/** 沒有分區的那一段在編輯器裡的容器 id；分區 id 是 8 個小寫英數字元，不會撞到 */
export const UNGROUPED = "~ungrouped";
export type BoxId = GroupId | typeof UNGROUPED;

/** 編輯中的排列：分區順序，加上每個容器（沒有分區＋各分區）裡依序的攝影機 */
export interface Layout {
  groups: GroupId[];
  /** 鍵是 BoxId；每個分區都有一格，空的也有 */
  boxes: Record<string, CameraId[]>;
}

export interface Section {
  group: CameraGroupDto | null;
  cameras: CameraDto[];
}

/** 照伺服器的資料排出版面：攝影機依 position，分區依陣列順序；指到已不存在分區的攝影機當作沒有分區 */
export function layoutOf(cams: CameraDto[], groups: CameraGroupDto[]): Layout {
  const known = new Set(groups.map((g) => g.id));
  const boxes: Record<string, CameraId[]> = { [UNGROUPED]: [] };
  for (const g of groups) boxes[g.id] = [];
  for (const c of [...cams].sort((a, b) => a.position - b.position)) {
    boxes[c.groupId !== null && known.has(c.groupId) ? c.groupId : UNGROUPED]!.push(c.id);
  }
  return { groups: groups.map((g) => g.id), boxes };
}

export const arrangementOf = (layout: Layout): CameraLayoutDto => ({
  groups: layout.groups,
  cameras: ([UNGROUPED, ...layout.groups] as BoxId[]).flatMap((box) => (layout.boxes[box] ?? []).map((id) => ({ id, groupId: box === UNGROUPED ? null : box }))),
});

/** 首頁與清單用的分段：沒有分區的一段在最前面（沒有攝影機就省略），接著每個分區（空的也列出） */
export function sectionsOf(cams: CameraDto[], groups: CameraGroupDto[]): Section[] {
  const layout = layoutOf(cams, groups);
  const byId = new Map(cams.map((c) => [c.id, c]));
  const pick = (box: BoxId) => (layout.boxes[box] ?? []).map((id) => byId.get(id)!);
  const ungrouped = pick(UNGROUPED);
  return [...(ungrouped.length ? [{ group: null, cameras: ungrouped }] : []), ...groups.map((g) => ({ group: g, cameras: pick(g.id) }))];
}

/** 把排列套回快取裡的攝影機與分區（送出後先換上，不等伺服器回應） */
export function applyLayout(cams: CameraDto[], groups: CameraGroupDto[], layout: Layout): { cams: CameraDto[]; groups: CameraGroupDto[] } {
  const seq = arrangementOf(layout).cameras;
  const at = new Map(seq.map((c, i) => [c.id, { position: i, groupId: c.groupId }]));
  const order = new Map(layout.groups.map((id, i) => [id, i]));
  return {
    cams: cams.map((c) => ({ ...c, ...(at.get(c.id) ?? {}) })).sort((a, b) => a.position - b.position),
    groups: [...groups].sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity)),
  };
}

/** 攝影機在哪個容器 */
export const boxOf = (layout: Layout, cam: CameraId): BoxId | null =>
  (Object.keys(layout.boxes) as BoxId[]).find((box) => layout.boxes[box]!.includes(cam)) ?? null;

/** 把攝影機移到某個容器的第 index 個位置（同一個容器裡也可以），回傳新的排列 */
export function moveCamera(layout: Layout, cam: CameraId, to: BoxId, index: number): Layout {
  const from = boxOf(layout, cam);
  if (from === null || !(to in layout.boxes)) return layout;
  const boxes = { ...layout.boxes, [from]: layout.boxes[from]!.filter((id) => id !== cam) };
  const target = [...boxes[to]!];
  target.splice(Math.max(0, Math.min(index, target.length)), 0, cam);
  boxes[to] = target;
  return { ...layout, boxes };
}
