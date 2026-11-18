import type { Database } from "bun:sqlite";
import type { Camera, CameraConfig, CameraId, CameraStore } from "../types.ts";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 8;

interface CameraRow {
  id: string;
  position: number;
  config: string;
  created_at: number;
  updated_at: number;
}

function randomId(): CameraId {
  let id = "";
  while (id.length < ID_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      // 252 = 36 * 7，超過的值丟掉，避免取餘數造成偏差
      if (byte < 252 && id.length < ID_LENGTH) id += ID_ALPHABET[byte % ID_ALPHABET.length];
    }
  }
  return id as CameraId;
}

function toCamera(row: CameraRow): Camera {
  return {
    id: row.id as CameraId,
    position: row.position,
    config: JSON.parse(row.config) as CameraConfig,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createCameraStore(db: Database, now: () => number = Date.now): CameraStore {
  const listeners = new Set<(cameras: Camera[]) => void>();

  const list = (): Camera[] =>
    (db.query("SELECT * FROM cameras ORDER BY position, created_at").all() as CameraRow[]).map(toCamera);

  const get = (id: CameraId): Camera | null => {
    const row = db.query("SELECT * FROM cameras WHERE id = ?").get(id) as CameraRow | null;
    return row ? toCamera(row) : null;
  };

  function notify() {
    const cameras = list();
    for (const listener of listeners) {
      try {
        listener(cameras);
      } catch (err) {
        console.error("[camera-store] subscriber threw", err);
      }
    }
  }

  return {
    list,
    get,

    create(config) {
      const t = now();
      let id = randomId();
      while (get(id)) id = randomId();
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
  };
}
