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
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { useRetained } from "../../ui/use-retained.ts";
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
  const { t } = useLingui();
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
  const boxName = (box: BoxId) => (box === UNGROUPED ? t`Ungrouped` : (groupById.get(box)?.name ?? ""));

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const arrange = useMutation({
    mutationFn: async ({ next }: { next: Layout; done?: string }) => {
      const body = arrangementOf(next);
      if (JSON.stringify(body) === JSON.stringify(arrangementOf(server))) return;
      const applied = applyLayout(cams, groups, next);
      qc.setQueryData(camerasQuery.queryKey, applied.cams);
      qc.setQueryData(cameraGroupsQuery.queryKey, applied.groups);
      const res = await api.arrangeCameras(body);
      qc.setQueryData(camerasQuery.queryKey, res.cameras);
      qc.setQueryData(cameraGroupsQuery.queryKey, res.groups);
    },
    meta: { handlesError: true },
    onSuccess: (_r, { done }) => {
      if (done) toast(done);
    },
    onError: (e) => {
      const reason = errMsg(e);
      toast(t`The arrangement wasn't saved: ${reason}`, "error");
      void qc.invalidateQueries({ queryKey: camerasQuery.queryKey });
      void qc.invalidateQueries({ queryKey: cameraGroupsQuery.queryKey });
    },
  });
  const save = (next: Layout, done?: string) => arrange.mutate({ next, done });

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
      save({ ...base, groups: arrayMove(base.groups, from, to) });
      return;
    }
    const box = boxOf(base, active.id as CameraId);
    if (box === null) return;
    const list = base.boxes[box]!;
    const to = isBoxKey(over.id) ? list.length - 1 : list.indexOf(over.id as CameraId);
    save(to < 0 ? base : moveCamera(base, active.id as CameraId, box, to));
  };

  const onDragCancel = () => {
    setActive(null);
    setDraft(null);
  };

  const camName = (id: UniqueIdentifier) => byId.get(String(id))?.config.name ?? "";
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      if (isGroupKey(active.id)) {
        const name = groupById.get(String(active.id).slice(2))?.name;
        return t`Picked up group "${name}"`;
      }
      const name = camName(active.id);
      return t`Picked up "${name}"`;
    },
    onDragOver: ({ active, over }) => {
      if (!over) return undefined;
      if (isGroupKey(active.id)) {
        const position = layout.groups.indexOf(String(over.id).slice(2) as GroupId) + 1;
        return t`Moved to group number ${position}`;
      }
      const box = boxOfKey(layout, over.id);
      if (box === null) return undefined;
      const name = boxName(box);
      return t`In "${name}"`;
    },
    onDragEnd: ({ active, over }) => {
      if (!over) return t`Move cancelled`;
      const name = isGroupKey(active.id) ? groupById.get(String(active.id).slice(2))?.name : camName(active.id);
      return t`Dropped "${name}"`;
    },
    onDragCancel: () => t`Move cancelled, position unchanged`,
  };

  const moveTo = (cam: CameraDto, box: BoxId) => {
    const next = moveCamera(server, cam.id, box, Infinity);
    const name = cam.config.name;
    const to = boxName(box);
    save(next, t`Moved "${name}" to "${to}"`);
  };

  const removeGroup = useMutation({
    mutationFn: (g: CameraGroupDto) => api.deleteCameraGroup(g.id),
    onSuccess: (_r, g) => {
      qc.setQueryData(cameraGroupsQuery.queryKey, (list) => list?.filter((x) => x.id !== g.id));
      qc.setQueryData(camerasQuery.queryKey, (list) => list?.map((c) => (c.groupId === g.id ? { ...c, groupId: null } : c)));
      const name = g.name;
      toast(t`Deleted group "${name}". Its cameras were moved to Ungrouped.`);
    },
  });

  const hasGroups = layout.groups.length > 0;
  const totalCameras = cams.length;
  const totalGroups = layout.groups.length;
  const cameraCount = plural(totalCameras, { one: "# camera", other: "# cameras" });
  const groupCount = plural(totalGroups, { one: "# group", other: "# groups" });
  const activeCam = active !== null && !isGroupKey(active) ? byId.get(String(active)) : undefined;
  const activeGroup = active !== null && isGroupKey(active) ? groupById.get(String(active).slice(2)) : undefined;

  const moveLabel = (name: string) => t`Move to "${name}"`;
  const rowsOf = (box: BoxId) => (
    <CameraBox box={box} ids={layout.boxes[box] ?? []} empty={box === UNGROUPED ? t`Cameras without a group appear first on the home page` : t`Drag cameras here`}>
      {(layout.boxes[box] ?? []).map((id) => {
        const cam = byId.get(id);
        if (!cam) return null;
        const moves: MenuItem[] = [UNGROUPED as BoxId, ...layout.groups].filter((b) => b !== box).map((b) => ({ label: b === UNGROUPED ? t`Move out of group` : moveLabel(boxName(b)), icon: b === UNGROUPED ? "minus" : "folder", onSelect: () => moveTo(cam, b) }));
        return <SortableRow key={id} cam={cam} moves={hasGroups ? moves : []} onRemove={onRemove} />;
      })}
    </CameraBox>
  );

  return (
    <>
      <div className="list-toolbar">
        <span className="hint num">{hasGroups ? t`${cameraCount}, ${groupCount}` : cameraCount}</span>
        <div className="list-toolbar-actions">
          <Button small icon="folder" iconSize={15} onClick={() => setNaming({ group: null })}>
            {t`Add group`}
          </Button>
          <ButtonLink to="/settings/cameras/new" variant="primary" small icon="plus" iconSize={15}>
            {t`Add camera`}
          </ButtonLink>
        </div>
      </div>
      <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={onDragCancel} accessibility={{ announcements, screenReaderInstructions: { draggable: t`Press Space or Enter to pick up, use the arrow keys to move, and press again to drop. Press Esc to cancel.` } }}>
        <div className="layout-editor" data-dragging={active !== null ? (isGroupKey(active) ? "group" : "camera") : undefined}>
          {/* 沒有未分區的攝影機就收起來；拖攝影機時才冒出來當放置區 */}
          {(layout.boxes[UNGROUPED]?.length ?? 0) > 0 || activeCam ? (
            <section className="layout-box" aria-label={hasGroups ? t`Ungrouped` : t`Cameras`}>
              {hasGroups ? (
                <header className="layout-head">
                  <h3>{t`Ungrouped`}</h3>
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
                <SortableGroup key={id} group={g} count={layout.boxes[id]?.length ?? 0} onRename={() => setNaming({ group: g })} onRemove={() => removeGroup.mutate(g)}>
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
      <GroupNameDialog state={naming} onClose={() => setNaming(null)} />
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
  const { t } = useLingui();
  const qc = useQueryClient();
  const c = cam.config;
  const name = c.name;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: cam.id });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.updateCamera(cam.id, { ...c, enabled }),
    onSuccess: (updated, enabled) => {
      putCamera(qc, updated);
      toast(enabled ? t`Enabled "${name}"` : t`Disabled "${name}"`);
    },
  });
  return (
    <div ref={setNodeRef} className="row-item cam-row" role="listitem" style={{ transform: CSS.Translate.toString(transform), transition }} data-placeholder={isDragging ? "" : undefined}>
      <RowBody
        cam={cam}
        handle={
          <button ref={setActivatorNodeRef} className="drag-handle" type="button" aria-label={t`Move "${name}"`} {...attributes} {...listeners}>
            <Icon name="grip" size={18} />
          </button>
        }
      />
      <div className="row-actions">
        <MenuButton
          label={t`More actions for "${name}"`}
          items={[
            ...moves,
            { label: c.enabled ? t`Disable` : t`Enable`, icon: "power", onSelect: () => toggle.mutate(!c.enabled) },
            { label: t`Delete`, icon: "trash", danger: true, onSelect: () => onRemove(cam) },
          ]}
        />
      </div>
    </div>
  );
}

function SortableGroup({ group, count, onRename, onRemove, children }: { group: CameraGroupDto; count: number; onRename: () => void; onRemove: () => void; children: ReactNode }) {
  const { t } = useLingui();
  const name = group.name;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: groupKey(group.id) });
  return (
    <section ref={setNodeRef} className="layout-box" aria-label={group.name} style={{ transform: CSS.Translate.toString(transform), transition }} data-placeholder={isDragging ? "" : undefined}>
      <header className="layout-head">
        <button ref={setActivatorNodeRef} className="drag-handle" type="button" aria-label={t`Move group "${name}"`} {...attributes} {...listeners}>
          <Icon name="grip" size={18} />
        </button>
        <h3 className="truncate">{group.name}</h3>
        <span className="layout-count num">{count}</span>
        <MenuButton
          label={t`More actions for group "${name}"`}
          items={[
            { label: t`Rename`, icon: "edit", onSelect: onRename },
            { label: t`Delete group`, icon: "trash", danger: true, onSelect: onRemove },
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

function GroupNameDialog({ state, onClose }: { state: { group: CameraGroupDto | null } | null; onClose: () => void }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  // 關閉動畫播放時 state 已經是 null，標題與預設值沿用最後一次的
  const [shown] = useRetained(state);
  const renaming = shown?.group ?? null;
  const save = useMutation({
    mutationFn: async (name: string) => {
      if (renaming) {
        const g = await api.renameCameraGroup(renaming.id, name);
        qc.setQueryData(cameraGroupsQuery.queryKey, (list) => list?.map((x) => (x.id === g.id ? g : x)));
      } else {
        const g = await api.createCameraGroup(name);
        qc.setQueryData(cameraGroupsQuery.queryKey, (list) => (list?.some((x) => x.id === g.id) ? list : [...(list ?? []), g]));
        const groupName = g.name;
        toast(t`Added group "${groupName}". Drag cameras into it.`);
      }
    },
    meta: { handlesError: true },
    onSuccess: onClose,
    onError: (err) => setError(errMsg(err)),
  });
  const busy = save.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = input.current!.value.trim();
    if (!value) {
      setError(t`Give this group a name`);
      return input.current!.focus();
    }
    setError("");
    save.mutate(value);
  };
  return (
    <Dialog open={state !== null} onOpenChange={(o) => !o && onClose()} title={renaming ? t`Rename group` : t`Add group`} initialFocus={input} onClosed={() => setError("")}>
      <form className="form" onSubmit={submit}>
        <Field label={t`Group name`} hint={renaming ? undefined : t`For example "Downstairs" or "Outdoors". The home page shows cameras in sections by group.`} error={error}>
          <input key={renaming?.id ?? "new"} ref={input} type="text" maxLength={MAX_GROUP_NAME} autoComplete="off" defaultValue={renaming?.name ?? ""} placeholder={t`For example: Outdoors`} onFocus={(e) => e.currentTarget.select()} />
        </Field>
        <div className="dlg-actions">
          <Button onClick={onClose}>{t`Cancel`}</Button>
          <Button type="submit" variant="primary" aria-busy={busy || undefined} disabled={busy}>
            {renaming ? t`Save` : t`Add`}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
