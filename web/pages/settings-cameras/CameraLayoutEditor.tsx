import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { CameraDto, CameraGroupDto } from "../../../src/api-types.ts";
import type { CameraId, GroupId } from "../../../src/types.ts";
import { api } from "../../api.ts";
import { applyLayout, arrangementOf, boxOf, layoutOf, moveCamera, UNGROUPED, type BoxId, type Layout } from "../../camera-layout.ts";
import { cameraGroupsQuery, camerasQuery } from "../../data/queries.ts";
import { errMsg } from "../../format.ts";
import { cameraStatus } from "../../health.ts";
import { Button, ButtonLink } from "../../ui/Button.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { Field } from "../../ui/Field.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { MenuButton, type MenuItem } from "../../ui/Menu.tsx";
import { Badge } from "../../ui/Panel.tsx";
import { toast } from "../../ui/toast.tsx";
import { putCamera } from "./cache.ts";

/*
 * dnd-kit 的 id：攝影機用自己的 id，分區卡片用 g:<分區 id>，放攝影機的容器用 box:<BoxId>。
 * 拖分區時只跟其他分區比位置，拖攝影機時只跟攝影機與容器比。
 */
const groupKey = (id: GroupId) => `g:${id}`;
const boxKey = (box: BoxId) => `box:${box}`;
const isGroupKey = (id: UniqueIdentifier) => String(id).startsWith("g:");
const isBoxKey = (id: UniqueIdentifier) => String(id).startsWith("box:");

const collision: CollisionDetection = (args) => {
  const draggingGroup = isGroupKey(args.active.id);
  const pool = args.droppableContainers.filter((c) => isGroupKey(c.id) === draggingGroup);
  const scoped = { ...args, droppableContainers: pool };
  if (draggingGroup) return closestCenter(scoped);
  // 指標底下有攝影機就對準那台；只碰到容器（空的分區）才放進容器；鍵盤操作沒有指標，找最近的
  const within = pointerWithin(scoped);
  const cams = within.filter((c) => !isBoxKey(c.id));
  if (cams.length) return cams;
  if (within.length) return within;
  return closestCenter(scoped);
};

const MAX_GROUP_NAME = 40;

/**
 * 設定 → 攝影機：可以拖曳排序的清單，攝影機分在各分區裡，分區本身也能拖。
 * 放開就存，不用按儲存；先換掉快取再送出，失敗才退回伺服器的版本。
 */
export function CameraLayoutEditor({ cams, onRemove }: { cams: CameraDto[]; onRemove: (cam: CameraDto) => void }) {
  const qc = useQueryClient();
  const groups = useQuery(cameraGroupsQuery).data ?? [];
  const server = useMemo(() => layoutOf(cams, groups), [cams, groups]);
  // 拖曳中的排列；放開或取消後回到 null，畫面跟著伺服器（SSE）的資料走
  const [draft, setDraft] = useState<Layout | null>(null);
  const [active, setActive] = useState<UniqueIdentifier | null>(null);
  const [naming, setNaming] = useState<{ group: CameraGroupDto | null } | null>(null);
  const layout = draft ?? server;
  const byId = useMemo(() => new Map(cams.map((c) => [c.id as string, c])), [cams]);
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id as string, g])), [groups]);
  const boxName = (box: BoxId) => (box === UNGROUPED ? "未分區" : (groupById.get(box)?.name ?? ""));

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const save = async (next: Layout) => {
    const body = arrangementOf(next);
    if (JSON.stringify(body) === JSON.stringify(arrangementOf(server))) return;
    const applied = applyLayout(cams, groups, next);
    qc.setQueryData(camerasQuery.queryKey, applied.cams);
    qc.setQueryData(cameraGroupsQuery.queryKey, applied.groups);
    try {
      const res = await api.arrangeCameras(body);
      qc.setQueryData(camerasQuery.queryKey, res.cameras);
      qc.setQueryData(cameraGroupsQuery.queryKey, res.groups);
    } catch (e) {
      toast(`排列沒有存起來：${errMsg(e)}`, "error");
      void qc.invalidateQueries({ queryKey: camerasQuery.queryKey });
      void qc.invalidateQueries({ queryKey: cameraGroupsQuery.queryKey });
    }
  };

  const boxOfKey = (l: Layout, id: UniqueIdentifier): BoxId | null => (isBoxKey(id) ? (String(id).slice(4) as BoxId) : boxOf(l, id as CameraId));

  const onDragStart = ({ active }: DragStartEvent) => {
    setActive(active.id);
    setDraft(server);
  };

  // 拖到別的容器上時先把攝影機搬過去，讓那邊空出位置；同一個容器裡的換位交給 SortableContext
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || isGroupKey(active.id) || !draft) return;
    const from = boxOf(draft, active.id as CameraId);
    const to = boxOfKey(draft, over.id);
    if (from === null || to === null || from === to) return;
    const target = draft.boxes[to] ?? [];
    const index = isBoxKey(over.id) ? target.length : target.indexOf(over.id as CameraId);
    setDraft(moveCamera(draft, active.id as CameraId, to, index < 0 ? target.length : index));
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const base = draft ?? server;
    setActive(null);
    setDraft(null);
    if (!over) return;
    if (isGroupKey(active.id)) {
      const ids = base.groups.map(groupKey);
      const from = ids.indexOf(String(active.id));
      const to = ids.indexOf(String(over.id));
      if (from < 0 || to < 0) return;
      void save({ ...base, groups: arrayMove(base.groups, from, to) });
      return;
    }
    const box = boxOf(base, active.id as CameraId);
    if (box === null) return;
    const list = base.boxes[box]!;
    const to = isBoxKey(over.id) ? list.length - 1 : list.indexOf(over.id as CameraId);
    void save(to < 0 ? base : moveCamera(base, active.id as CameraId, box, to));
  };

  const onDragCancel = () => {
    setActive(null);
    setDraft(null);
  };

  const camName = (id: UniqueIdentifier) => byId.get(String(id))?.config.name ?? "";
  const announcements: Announcements = {
    onDragStart: ({ active }) => (isGroupKey(active.id) ? `已拿起分區「${groupById.get(String(active.id).slice(2))?.name}」` : `已拿起「${camName(active.id)}」`),
    onDragOver: ({ active, over }) => {
      if (!over) return undefined;
      if (isGroupKey(active.id)) return `移到第 ${layout.groups.indexOf(String(over.id).slice(2) as GroupId) + 1} 個分區`;
      const box = boxOfKey(layout, over.id);
      return box === null ? undefined : `在「${boxName(box)}」裡`;
    },
    onDragEnd: ({ active, over }) => (over ? `已放下「${isGroupKey(active.id) ? groupById.get(String(active.id).slice(2))?.name : camName(active.id)}」` : "已取消移動"),
    onDragCancel: () => "已取消移動，位置不變",
  };

  const moveTo = (cam: CameraDto, box: BoxId) => {
    const next = moveCamera(server, cam.id, box, Infinity);
    void save(next).then(() => toast(`已把「${cam.config.name}」移到「${boxName(box)}」`));
  };

  const removeGroup = async (g: CameraGroupDto) => {
    try {
      await api.deleteCameraGroup(g.id);
      qc.setQueryData(cameraGroupsQuery.queryKey, (list) => list?.filter((x) => x.id !== g.id));
      qc.setQueryData(camerasQuery.queryKey, (list) => list?.map((c) => (c.groupId === g.id ? { ...c, groupId: null } : c)));
      toast(`已刪除分區「${g.name}」，裡面的攝影機移到未分區`);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const hasGroups = layout.groups.length > 0;
  const activeCam = active !== null && !isGroupKey(active) ? byId.get(String(active)) : undefined;
  const activeGroup = active !== null && isGroupKey(active) ? groupById.get(String(active).slice(2)) : undefined;

  const rowsOf = (box: BoxId) => (
    <CameraBox box={box} ids={layout.boxes[box] ?? []} empty={box === UNGROUPED ? "沒有分區的攝影機會排在首頁最前面" : "把攝影機拖到這裡"}>
      {(layout.boxes[box] ?? []).map((id) => {
        const cam = byId.get(id);
        if (!cam) return null;
        const moves: MenuItem[] = [UNGROUPED as BoxId, ...layout.groups].filter((b) => b !== box).map((b) => ({ label: b === UNGROUPED ? "移出分區" : `移到「${boxName(b)}」`, icon: b === UNGROUPED ? "minus" : "folder", onSelect: () => moveTo(cam, b) }));
        return <SortableRow key={id} cam={cam} moves={hasGroups ? moves : []} onRemove={onRemove} />;
      })}
    </CameraBox>
  );

  return (
    <>
      <div className="list-toolbar">
        <span className="hint num">{`共 ${cams.length} 台${hasGroups ? `，${layout.groups.length} 個分區` : ""}`}</span>
        <div className="list-toolbar-actions">
          <Button small icon="folder" iconSize={15} onClick={() => setNaming({ group: null })}>
            新增分區
          </Button>
          <ButtonLink to="/settings/cameras/new" variant="primary" small icon="plus" iconSize={15}>
            新增攝影機
          </ButtonLink>
        </div>
      </div>
      <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={onDragCancel} accessibility={{ announcements, screenReaderInstructions: { draggable: "按空白鍵或 Enter 拿起，用方向鍵移動，再按一次放下；按 Esc 取消。" } }}>
        <div className="layout-editor" data-dragging={active !== null ? (isGroupKey(active) ? "group" : "camera") : undefined}>
          {/* 沒有未分區的攝影機就收起來；拖攝影機時才冒出來當放置區 */}
          {(layout.boxes[UNGROUPED]?.length ?? 0) > 0 || activeCam ? (
            <section className="layout-box" aria-label={hasGroups ? "未分區" : "攝影機"}>
              {hasGroups ? (
                <header className="layout-head">
                  <h3>未分區</h3>
                  <span className="layout-count num">{layout.boxes[UNGROUPED]?.length ?? 0}</span>
                </header>
              ) : null}
              {rowsOf(UNGROUPED)}
            </section>
          ) : null}
          <SortableContext items={layout.groups.map(groupKey)} strategy={verticalListSortingStrategy}>
            {layout.groups.map((id) => {
              const g = groupById.get(id);
              if (!g) return null;
              return (
                <SortableGroup key={id} group={g} count={layout.boxes[id]?.length ?? 0} onRename={() => setNaming({ group: g })} onRemove={() => void removeGroup(g)}>
                  {rowsOf(id)}
                </SortableGroup>
              );
            })}
          </SortableContext>
        </div>
        <DragOverlay dropAnimation={{ duration: 200, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }}>
          {activeCam ? <RowBody cam={activeCam} overlay /> : activeGroup ? <GroupOverlay group={activeGroup} count={layout.boxes[activeGroup.id]?.length ?? 0} /> : null}
        </DragOverlay>
      </DndContext>
      <GroupNameDialog
        state={naming}
        onClose={() => setNaming(null)}
        onSubmit={async (name) => {
          if (naming?.group) {
            const g = await api.renameCameraGroup(naming.group.id, name);
            qc.setQueryData(cameraGroupsQuery.queryKey, (list) => list?.map((x) => (x.id === g.id ? g : x)));
          } else {
            const g = await api.createCameraGroup(name);
            qc.setQueryData(cameraGroupsQuery.queryKey, (list) => (list?.some((x) => x.id === g.id) ? list : [...(list ?? []), g]));
            toast(`已新增分區「${g.name}」，把攝影機拖進去吧`);
          }
        }}
      />
    </>
  );
}

/** 放攝影機的容器（未分區或某個分區的清單）；空的時候是一塊放置區 */
function CameraBox({ box, ids, empty, children }: { box: BoxId; ids: CameraId[]; empty: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: boxKey(box) });
  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      <div ref={setNodeRef} className="card row-list layout-list" role="list" data-over={isOver ? "" : undefined} data-empty={ids.length === 0 ? "" : undefined}>
        {ids.length === 0 ? <p className="layout-empty">{empty}</p> : children}
      </div>
    </SortableContext>
  );
}

function RowBody({ cam, handle, overlay }: { cam: CameraDto; handle?: ReactNode; overlay?: boolean }) {
  const c = cam.config;
  const st = cameraStatus(cam);
  const body = (
    <>
      <span className="row-ico">
        <Icon name={c.connection.type === "tapo" ? "tapo" : "link"} size={18} />
      </span>
      <span className="row-text">
        <b className="truncate">{c.name}</b>
      </span>
    </>
  );
  if (overlay) {
    return (
      <div className="row-item cam-row drag-overlay">
        <span className="drag-handle" aria-hidden="true">
          <Icon name="grip" size={18} />
        </span>
        <span className="row-main">{body}</span>
        <Badge kind={st.tone}>{st.label}</Badge>
      </div>
    );
  }
  return (
    <>
      {handle}
      {/* 整列都能點進編輯：連結的 ::after 蓋住整列，把手與選單按鈕疊在上面 */}
      <Link className="row-main row-link stretch" to="/settings/cameras/$id" params={{ id: cam.id }}>
        {body}
      </Link>
      <Badge kind={st.tone}>{st.label}</Badge>
    </>
  );
}

function SortableRow({ cam, moves, onRemove }: { cam: CameraDto; moves: MenuItem[]; onRemove: (cam: CameraDto) => void }) {
  const qc = useQueryClient();
  const c = cam.config;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: cam.id });
  const toggle = async () => {
    try {
      putCamera(qc, await api.updateCamera(cam.id, { ...c, enabled: !c.enabled }));
      toast(c.enabled ? `已停用「${c.name}」` : `已啟用「${c.name}」`);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <div ref={setNodeRef} className="row-item cam-row" role="listitem" style={{ transform: CSS.Translate.toString(transform), transition }} data-placeholder={isDragging ? "" : undefined}>
      <RowBody
        cam={cam}
        handle={
          <button ref={setActivatorNodeRef} className="drag-handle" type="button" aria-label={`移動「${c.name}」`} {...attributes} {...listeners}>
            <Icon name="grip" size={18} />
          </button>
        }
      />
      <div className="row-actions">
        <MenuButton
          label={`「${c.name}」的更多動作`}
          items={[
            ...moves,
            { label: c.enabled ? "停用" : "啟用", icon: "power", onSelect: () => void toggle() },
            { label: "刪除", icon: "trash", danger: true, onSelect: () => onRemove(cam) },
          ]}
        />
      </div>
    </div>
  );
}

function SortableGroup({ group, count, onRename, onRemove, children }: { group: CameraGroupDto; count: number; onRename: () => void; onRemove: () => void; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: groupKey(group.id) });
  return (
    <section ref={setNodeRef} className="layout-box" aria-label={group.name} style={{ transform: CSS.Translate.toString(transform), transition }} data-placeholder={isDragging ? "" : undefined}>
      <header className="layout-head">
        <button ref={setActivatorNodeRef} className="drag-handle" type="button" aria-label={`移動分區「${group.name}」`} {...attributes} {...listeners}>
          <Icon name="grip" size={18} />
        </button>
        <h3 className="truncate">{group.name}</h3>
        <span className="layout-count num">{count}</span>
        <MenuButton
          label={`分區「${group.name}」的更多動作`}
          items={[
            { label: "重新命名", icon: "edit", onSelect: onRename },
            { label: "刪除分區", icon: "trash", danger: true, onSelect: onRemove },
          ]}
        />
      </header>
      {children}
    </section>
  );
}

function GroupOverlay({ group, count }: { group: CameraGroupDto; count: number }) {
  return (
    <div className="layout-head drag-overlay">
      <span className="drag-handle" aria-hidden="true">
        <Icon name="grip" size={18} />
      </span>
      <h3 className="truncate">{group.name}</h3>
      <span className="layout-count num">{count}</span>
    </div>
  );
}

function GroupNameDialog({ state, onClose, onSubmit }: { state: { group: CameraGroupDto | null } | null; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // 關閉動畫播放時 state 已經是 null，標題與預設值沿用最後一次的
  const [shown, setShown] = useState(state);
  if (state && state !== shown) setShown(state);
  const renaming = shown?.group ?? null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = input.current!.value.trim();
    if (!value) {
      setError("請幫這個分區取個名稱");
      return input.current!.focus();
    }
    setError("");
    setBusy(true);
    try {
      await onSubmit(value);
      onClose();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={state !== null} onOpenChange={(o) => !o && onClose()} title={renaming ? "重新命名分區" : "新增分區"} initialFocus={input} onClosed={() => setError("")}>
      <form className="form" onSubmit={submit}>
        <Field label="分區名稱" hint={renaming ? undefined : "例如「一樓」「戶外」。首頁會照分區分段顯示。"} error={error}>
          <input key={renaming?.id ?? "new"} ref={input} type="text" maxLength={MAX_GROUP_NAME} autoComplete="off" defaultValue={renaming?.name ?? ""} placeholder="例如：戶外" onFocus={(e) => e.currentTarget.select()} />
        </Field>
        <div className="dlg-actions">
          <Button onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary" aria-busy={busy || undefined} disabled={busy}>
            {renaming ? "儲存" : "新增"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
