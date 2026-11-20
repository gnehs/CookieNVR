import type { Database } from "bun:sqlite";
import type { Camera, CameraConfig, CameraGroup, CameraId, CameraStore, GroupId } from "../types.ts";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 8;

interface CameraRow {
  id: string;
  position: number;
  group_id: string | null;
  config: string;
  created_at: number;
  updated_at: number;
}

interface GroupRow {
  id: string;
  name: string;
  position: number;
}

function randomId(): string {
  let id = "";
  while (id.length < ID_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      // 252 = 36 * 7，超過的值丟掉，避免取餘數造成偏差
      if (byte < 252 && id.length < ID_LENGTH) id += ID_ALPHABET[byte % ID_ALPHABET.length];
    }
  }
  return id;
}

function toCamera(row: CameraRow): Camera {
  return {
    id: row.id as CameraId,
    position: row.position,
    groupId: row.group_id as GroupId | null,
    config: JSON.parse(row.config) as CameraConfig,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createCameraStore(db: Database, now: () => number = Date.now): CameraStore {
  const listeners = new Set<(cameras: Camera[]) => void>();
  const groupListeners = new Set<(groups: CameraGroup[]) => void>();

  const list = (): Camera[] =>
    (db.query("SELECT * FROM cameras ORDER BY position, created_at").all() as CameraRow[]).map(toCamera);

  const get = (id: CameraId): Camera | null => {
    const row = db.query("SELECT * FROM cameras WHERE id = ?").get(id) as CameraRow | null;
    return row ? toCamera(row) : null;
  };

  const groups = (): CameraGroup[] =>
    (db.query("SELECT id, name, position FROM camera_groups ORDER BY position, created_at").all() as GroupRow[]).map((r) => ({
      id: r.id as GroupId,
      name: r.name,
      position: r.position,
    }));

  const getGroup = (id: GroupId): CameraGroup | null => groups().find((g) => g.id === id) ?? null;

  function emit<T>(set: Set<(value: T) => void>, value: T) {
    for (const listener of set) {
      try {
        listener(value);
      } catch (err) {
        console.error("[camera-store] subscriber threw", err);
      }
    }
  }
  const notify = () => emit(listeners, list());
  const notifyGroups = () => emit(groupListeners, groups());

  // 排列的指紋：分區順序加上每台的分區與位置，用來判斷 arrange 有沒有真的改到東西
  const layoutKey = () => JSON.stringify([groups().map((g) => g.id), list().map((c) => [c.id, c.groupId])]);

  return {
    list,
    get,

    create(config) {
      const t = now();
      let id = randomId() as CameraId;
      while (get(id)) id = randomId() as CameraId;
      db.query(
        `INSERT INTO cameras (id, position, config, created_at, updated_at)
         VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM cameras), ?, ?, ?)`,
      ).run(id, JSON.stringify(config), t, t);
      const camera = get(id)!;
      notify();
      return camera;
    },

    update(id, config) {
      const changes = db
        .query("UPDATE cameras SET config = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(config), now(), id).changes;
      if (changes === 0) throw new Error(`camera not found: ${id}`);
      const camera = get(id)!;
      notify();
      return camera;
    },

    remove(id) {
      if (db.query("DELETE FROM cameras WHERE id = ?").run(id).changes > 0) notify();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    groups,

    createGroup(name) {
      const t = now();
      let id = randomId() as GroupId;
      while (getGroup(id)) id = randomId() as GroupId;
      db.query(
        `INSERT INTO camera_groups (id, name, position, created_at, updated_at)
         VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM camera_groups), ?, ?)`,
      ).run(id, name, t, t);
      notifyGroups();
      return getGroup(id)!;
    },

    renameGroup(id, name) {
      if (db.query("UPDATE camera_groups SET name = ?, updated_at = ? WHERE id = ?").run(name, now(), id).changes === 0) {
        throw new Error(`camera group not found: ${id}`);
      }
      notifyGroups();
      return getGroup(id)!;
    },

    removeGroup(id) {
      const inGroup = list().some((c) => c.groupId === id);
      if (db.query("DELETE FROM camera_groups WHERE id = ?").run(id).changes === 0) return;
      notifyGroups();
      if (inGroup) notify();
    },

    arrange(arrangement) {
      const before = layoutKey();
      db.transaction(() => {
        const existingGroups = groups();
        const known = new Set(existingGroups.map((g) => g.id));
        const order = [...new Set([...arrangement.groups.filter((id) => known.has(id)), ...existingGroups.map((g) => g.id)])];
        const t = now();
        order.forEach((id, i) => db.query("UPDATE camera_groups SET position = ?, updated_at = ? WHERE id = ?").run(i, t, id));

        const existing = list();
        const current = new Map(existing.map((c) => [c.id, c.groupId]));
        const placed = new Map<CameraId, GroupId | null>();
        for (const c of arrangement.cameras) {
          if (!current.has(c.id) || placed.has(c.id)) continue;
          placed.set(c.id, c.groupId !== null && known.has(c.groupId) ? c.groupId : null);
        }
        for (const c of existing) if (!placed.has(c.id)) placed.set(c.id, c.groupId);

        // 全站一條順序：沒有分區的在前，接著依分區順序，各區裡照送來的順序
        const sequence = [null, ...order].flatMap((g) => [...placed].filter(([, groupId]) => groupId === g));
        sequence.forEach(([id, groupId], i) => db.query("UPDATE cameras SET position = ?, group_id = ? WHERE id = ?").run(i, groupId, id));
      })();
      if (layoutKey() === before) return;
      notifyGroups();
      notify();
    },

    subscribeGroups(listener) {
      groupListeners.add(listener);
      return () => void groupListeners.delete(listener);
    },
  };
}
