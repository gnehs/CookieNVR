// 假後端的狀態辨識：全部放記憶體，API 形狀照 src/api-types.ts 的「狀態辨識」一節。
// 預設有兩個感應器：第一台的「鐵捲門」（關／移動中／開）已訓練、會自己循環切換；第二台的「車庫門」還沒訓練，
// 有幾張待標記的圖，用來走標記與訓練的流程。圖片與縮圖都是即時畫的 SVG（用不到 ffmpeg）。
import type { CameraId, CameraConfig } from "../src/types.ts";
import { HttpError } from "../src/http/errors.ts";
import { parseClassName, parseFrigateConfig, parseSensorConfig } from "../src/states/config.ts";
import {
  MAX_PENDING_STATE_IMAGES,
  MIN_STATE_IMAGES_PER_CLASS,
  type CropBox,
  type FrigateConfigResultDto,
  type StateChangeDto,
  type StateImageDto,
  type StateImageSource,
  type StateJobDto,
  type StateJobKind,
  type StateModelDto,
  type StateSensorConfig,
  type StateSensorDto,
  type StreamMessage,
} from "../src/api-types.ts";

export interface MockStatesDeps {
  cameras: () => readonly { id: CameraId; config: CameraConfig }[];
  emit: (message: Extract<StreamMessage, { type: "state-change" | "state-sensor" | "state-sensor-removed" }>) => void;
}

export interface MockStatesRequest {
  /** 已去掉 /api 的路徑 */
  path: string;
  method: string;
  url: URL;
  body: unknown;
  admin: boolean;
}

interface Img {
  id: string;
  label: string | null;
  source: StateImageSource;
  createdAt: number;
  guess: { label: string; score: number } | null;
  /** 畫面長相：0 = 第一類、1 = 最後一類，中間的類別平均分布 */
  look: number;
  seed: number;
}

interface Sensor {
  id: string;
  cameraId: CameraId;
  config: StateSensorConfig;
  state: string | null;
  since: number | null;
  score: number | null;
  candidate: { label: string; count: number } | null;
  lastReading: StateSensorDto["lastReading"];
  model: StateModelDto | null;
  images: Img[];
  job: StateJobDto | null;
  createdAt: number;
  /** 模擬用：往第幾類的方向走、下一次開始切換的時間 */
  dir: 1 | -1;
  nextAt: number;
  jobTimer: ReturnType<typeof setInterval> | null;
}

interface Change {
  dto: StateChangeDto;
  look: number;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const COLLECT_COUNT = 24;
const CONFIDENCE_STEPS = 3;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (status: number, error: string) => Response.json({ error }, { status });

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (rand: () => number, lo: number, hi: number) => lo + rand() * (hi - lo);

// ---------- 設定驗證：和真後端共用同一份解析 ----------
function attempt<T>(fn: () => T): Parsed<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    if (e instanceof HttpError) return { ok: false, error: e.message };
    throw e;
  }
}
const parseConfig = (raw: unknown, base: StateSensorConfig | null) => attempt(() => parseSensorConfig(raw, base ?? undefined));
const classNameError = (c: unknown) => {
  const r = attempt(() => parseClassName(c));
  return r.ok ? null : r.error;
};

// ---------- 圖片：即時畫的 SVG ----------
/** look 0 = 捲門放下（關）、1 = 捲起（開）；seed 決定亮度與雜訊，讓每張不太一樣 */
function renderSvg(look: number, seed: number): string {
  const r = rng(seed);
  const bright = between(r, 0.55, 1);
  const wall = `hsl(35 12% ${Math.round(38 * bright + 8)}%)`;
  const slat = `hsl(210 14% ${Math.round(58 * bright)}%)`;
  const slatEdge = `hsl(210 16% ${Math.round(40 * bright)}%)`;
  const inner = `hsl(30 20% ${Math.round(12 + look * 8)}%)`;
  const doorTop = 28;
  const doorH = 190;
  const covered = Math.round((1 - look) * doorH);
  const slats: string[] = [];
  for (let y = doorTop; y < doorTop + covered; y += 14) {
    slats.push(`<rect x="40" y="${y}" width="240" height="12" fill="${slat}" stroke="${slatEdge}"/>`);
  }
  const clutter = look > 0.4 ? `<rect x="${Math.round(between(r, 70, 200))}" y="170" width="46" height="46" fill="hsl(${Math.round(between(r, 0, 360))} 30% 40%)"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240" width="320" height="240"><rect width="320" height="240" fill="${wall}"/><rect x="40" y="${doorTop}" width="240" height="${doorH}" fill="${inner}"/>${clutter}${slats.join("")}<rect x="40" y="${doorTop}" width="240" height="${doorH}" fill="none" stroke="${slatEdge}" stroke-width="4"/></svg>`;
}

const svgResponse = (look: number, seed: number) => new Response(renderSvg(look, seed), { headers: { "content-type": "image/svg+xml", "cache-control": "max-age=60" } });

// ---------- 模型 ----------
const lookOf = (classes: string[], label: string) => {
  const i = classes.indexOf(label);
  return i < 0 ? 0 : i / (classes.length - 1);
};
const labelAt = (classes: string[], look: number) => classes[Math.round(look * (classes.length - 1))]!;

function buildModel(config: StateSensorConfig, images: Img[], trainMs: number): StateModelDto {
  const classes = [...config.classes];
  const counts = classes.map((label) => ({ label, count: images.filter((i) => i.label === label).length }));
  const minCount = Math.min(...counts.map((c) => c.count));
  const perClass = counts.map((c, i) => ({ label: c.label, correct: c.count - (i === 1 ? Math.floor(c.count / 12) : 0), total: c.count }));
  const confusion = perClass.map((p, i) => {
    const row = classes.map(() => 0);
    row[i] = p.correct;
    const wrong = i + 1 < classes.length ? i + 1 : i - 1;
    row[wrong] = p.total - p.correct;
    return row;
  });
  const total = perClass.reduce((n, p) => n + p.total, 0);
  const correct = perClass.reduce((n, p) => n + p.correct, 0);
  return {
    trainedAt: Date.now(),
    classes,
    counts,
    validation: minCount >= 2 ? { folds: Math.min(5, minCount), accuracy: total ? correct / total : 0, perClass, confusion } : null,
    trainMs,
    backbone: "DINOv2-small (int8)",
  };
}

// ---------- Frigate 設定 ----------
const parseFrigate = (yaml: string) => attempt(() => parseFrigateConfig(yaml));

// ---------- 主體 ----------
export function createMockStates(deps: MockStatesDeps) {
  const sensors = new Map<string, Sensor>();
  const changes: Change[] = [];
  let sensorSeq = 1;
  let imageSeq = 1;
  let changeSeq = 1;

  const imageSeed = () => imageSeq * 7919;
  function newImage(look: number, label: string | null, source: StateImageSource, createdAt: number, guess: Img["guess"]): Img {
    const id = `img${imageSeq}`;
    const img: Img = { id, label, source, createdAt, guess, look, seed: imageSeed() };
    imageSeq++;
    return img;
  }

  const camOf = (id: CameraId) => deps.cameras().find((c) => c.id === id);

  function problemOf(s: Sensor): StateSensorDto["problem"] {
    if (!s.config.enabled) return { code: "disabled", message: "已暫停辨識" };
    if (!s.model) return { code: "untrained", message: "還沒訓練：先標記每一類的畫面，再按「開始訓練」" };
    if (s.model.classes.length !== s.config.classes.length || s.model.classes.some((c, i) => c !== s.config.classes[i])) return { code: "stale-model", message: "類別改過了，重新訓練後才會繼續辨識" };
    const cam = camOf(s.cameraId);
    if (!cam || !cam.config.enabled) return { code: "camera-off", message: "這台攝影機已停用，沒有畫面可以辨識" };
    return null;
  }

  function dto(s: Sensor): StateSensorDto {
    const labeled = s.config.classes.map((label) => ({ label, count: s.images.filter((i) => i.label === label).length }));
    const problem = problemOf(s);
    const idle = problem !== null;
    return {
      id: s.id,
      cameraId: s.cameraId,
      config: s.config,
      state: idle ? null : s.state,
      since: idle ? null : s.since,
      score: idle ? null : s.score,
      candidate: idle ? null : s.candidate,
      lastReading: idle ? null : s.lastReading,
      model: s.model,
      images: { pending: s.images.filter((i) => i.label === null).length, labeled },
      trainable: labeled.every((l) => l.count >= MIN_STATE_IMAGES_PER_CLASS),
      job: s.job,
      problem,
      createdAt: s.createdAt,
    };
  }

  const emitSensor = (s: Sensor) => deps.emit({ type: "state-sensor", data: dto(s) });
  const imageDto = (s: Sensor, i: Img): StateImageDto => ({ id: i.id, label: i.label, source: i.source, createdAt: i.createdAt, guess: i.guess, url: `/api/states/${s.id}/images/${i.id}` });

  function addChange(s: Sensor, at: number, from: string | null, to: string, score: number): StateChangeDto {
    const dto: StateChangeDto = { id: changeSeq++, sensorId: s.id, cameraId: s.cameraId, at, from, to, score, thumbUrl: null };
    dto.thumbUrl = `/api/state-changes/${dto.id}/thumb.jpg`;
    changes.push({ dto, look: lookOf(s.config.classes, to) });
    return dto;
  }

  function pendingCap(s: Sensor) {
    let live = s.images.filter((i) => i.label === null && i.source === "live");
    while (s.images.filter((i) => i.label === null).length > MAX_PENDING_STATE_IMAGES && live.length) {
      const oldest = live.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
      s.images = s.images.filter((i) => i !== oldest);
      live = live.filter((i) => i !== oldest);
    }
  }

  // ---------- 辨識模擬 ----------
  function resetRecognition(s: Sensor, t = Date.now()) {
    s.state = null;
    s.since = null;
    s.score = null;
    s.candidate = null;
    s.lastReading = null;
    s.dir = 1;
    s.nextAt = t;
  }

  function nextLabel(s: Sensor): string {
    const classes = s.config.classes;
    if (s.state === null) return classes[0]!;
    const i = classes.indexOf(s.state);
    if (i + s.dir < 0 || i + s.dir >= classes.length) s.dir = s.dir === 1 ? -1 : 1;
    return classes[Math.min(classes.length - 1, Math.max(0, i + s.dir))]!;
  }

  function switchTo(s: Sensor, label: string, t: number, score: number) {
    const change = addChange(s, t, s.state, label, score);
    s.state = label;
    s.since = t;
    s.score = score;
    s.candidate = null;
    s.nextAt = t + between(Math.random, 20_000, 40_000);
    if (Math.random() < 0.5) {
      const look = lookOf(s.config.classes, label);
      s.images.push(newImage(look, null, "live", t, { label, score: between(Math.random, 0.5, 0.78) }));
      pendingCap(s);
    }
    deps.emit({ type: "state-change", data: change });
    emitSensor(s);
  }

  function tick(s: Sensor, t: number) {
    if (problemOf(s)) {
      if (s.state !== null || s.candidate) {
        resetRecognition(s, t);
        emitSensor(s);
      }
      return;
    }
    const score = between(Math.random, 0.9, 0.995);
    if (s.candidate) {
      s.candidate.count += 1;
      s.lastReading = { at: t, label: s.candidate.label, score };
      if (s.candidate.count >= CONFIDENCE_STEPS) switchTo(s, s.candidate.label, t, score);
      else emitSensor(s);
      return;
    }
    if (t >= s.nextAt) {
      const label = nextLabel(s);
      s.candidate = { label, count: 1 };
      s.lastReading = { at: t, label, score };
      emitSensor(s);
      return;
    }
    if (s.state) s.lastReading = { at: t, label: s.state, score };
  }

  setInterval(() => {
    const t = Date.now();
    for (const s of sensors.values()) tick(s, t);
  }, 1000);

  // ---------- 背景工作 ----------
  const busy = (s: Sensor) => s.job?.state === "queued" || s.job?.state === "running";

  function startJob(s: Sensor, kind: StateJobKind, durationMs: number, finish: () => Parsed<string>) {
    const startedAt = Date.now();
    s.job = { kind, state: "queued", startedAt };
    emitSensor(s);
    const end = (job: StateJobDto) => {
      if (s.jobTimer) clearInterval(s.jobTimer);
      s.jobTimer = null;
      s.job = job;
      emitSensor(s);
    };
    setTimeout(() => {
      if (!sensors.has(s.id)) return;
      const showProgress = kind === "train";
      s.job = { kind, state: "running", startedAt, progress: showProgress ? 0 : null };
      emitSensor(s);
      s.jobTimer = setInterval(() => {
        if (!sensors.has(s.id)) return end(s.job!);
        const elapsed = Date.now() - startedAt;
        if (elapsed < durationMs) {
          if (showProgress) {
            s.job = { kind, state: "running", startedAt, progress: Math.min(0.99, elapsed / durationMs) };
            emitSensor(s);
          }
          return;
        }
        const result = finish();
        const finishedAt = Date.now();
        end(result.ok ? { kind, state: "done", startedAt, finishedAt, message: result.value } : { kind, state: "failed", startedAt, finishedAt, error: result.error });
      }, 500);
    }, 400);
  }

  function runCollect(s: Sensor) {
    startJob(s, "collect", 1800, () => {
      const cam = camOf(s.cameraId);
      if (!cam?.config.record.enabled) return { ok: false, error: "這台攝影機沒有錄影，沒辦法從錄影抽樣畫面" };
      const r = rng(Date.now());
      for (let i = 0; i < COLLECT_COUNT; i++) {
        s.images.push(newImage(r(), null, "recording", Date.now() - i * 5 * MIN, null));
      }
      return { ok: true, value: `加入 ${COLLECT_COUNT} 張待標記的畫面` };
    });
  }

  function runTrain(s: Sensor) {
    startJob(s, "train", 6000, () => {
      s.model = buildModel(s.config, s.images, 6000);
      resetRecognition(s);
      const pct = Math.round((s.model.validation?.accuracy ?? 0) * 100);
      return { ok: true, value: s.model.validation ? `訓練完成，交叉驗證準確度 ${pct}%` : "訓練完成" };
    });
  }

  function runImport(s: Sensor) {
    startJob(s, "import", 3000, () => {
      const r = rng(Date.now());
      if (!s.config.classes.includes("半開")) s.config.classes = [...s.config.classes, "半開"];
      const classes = s.config.classes;
      let labeled = 0;
      for (const label of classes) {
        for (let i = 0; i < 4; i++) {
          s.images.push(newImage(lookOf(classes, label), label, "import", Date.now() - i * HOUR, null));
          labeled++;
        }
      }
      for (let i = 0; i < 6; i++) {
        const look = r();
        const guess = { label: labelAt(classes, look), score: between(r, 0.4, 0.95) };
        s.images.push(newImage(look, null, "import", Date.now() - i * HOUR, guess));
      }
      return { ok: true, value: `匯入 ${labeled} 張已標記、6 張待標記的圖片，新增類別「半開」` };
    });
  }

  // ---------- 建立與種子資料 ----------
  function createSensor(cameraId: CameraId, config: StateSensorConfig, t = Date.now()): Sensor {
    const s: Sensor = {
      id: `st${sensorSeq++}`,
      cameraId,
      config,
      state: null,
      since: null,
      score: null,
      candidate: null,
      lastReading: null,
      model: null,
      images: [],
      job: null,
      createdAt: t,
      dir: 1,
      nextAt: t,
      jobTimer: null,
    };
    sensors.set(s.id, s);
    return s;
  }

  function seed() {
    const cams = deps.cameras();
    const t = Date.now();
    const first = cams[0];
    if (first) {
      const config: StateSensorConfig = { name: "鐵捲門", classes: ["關", "移動中", "開"], crop: [0.55, 0.35, 0.95, 0.95], threshold: 0.8, intervalSec: 10, onMotion: true, enabled: true };
      const s = createSensor(first.id, config, t - 5 * DAY);
      const r = rng(11);
      for (const label of config.classes) {
        for (let i = 0; i < 12; i++) {
          const source: StateImageSource = i < 8 ? "recording" : "live";
          s.images.push(newImage(lookOf(config.classes, label), label, source, t - 4 * DAY + i * HOUR, null));
        }
      }
      for (let i = 0; i < 20; i++) {
        const look = r();
        const source: StateImageSource = i % 5 === 0 ? "recording" : "live";
        const guess = source === "live" ? { label: labelAt(config.classes, i % 4 === 0 ? 1 - look : look), score: between(r, 0.45, 0.8) } : null;
        s.images.push(newImage(look, null, source, t - i * 3 * HOUR, guess));
      }
      s.model = { ...buildModel(config, s.images, 5400), trainedAt: t - 4 * DAY + 12 * HOUR };
      // 三天裡切換 30 次，最後一次在 5 分鐘前
      const gaps = Array.from({ length: 30 }, () => between(r, 0.5, 3));
      const scale = (3 * DAY - 5 * MIN) / gaps.reduce((a, b) => a + b, 0);
      let at = t - 3 * DAY;
      let idx = 0;
      let dirn: 1 | -1 = 1;
      let from: string | null = null;
      for (const gap of gaps) {
        at += gap * scale;
        const to = config.classes[idx]!;
        addChange(s, Math.round(at), from, to, between(r, 0.88, 0.995));
        from = to;
        if (idx + dirn < 0 || idx + dirn >= config.classes.length) dirn = dirn === 1 ? -1 : 1;
        idx += dirn;
      }
      const last = changes[changes.length - 1]!.dto;
      s.state = last.to;
      s.since = last.at;
      s.score = last.score;
      s.nextAt = t + between(Math.random, 8_000, 15_000);
      s.dir = dirn;
    }
    const second = cams[1];
    if (second) {
      const config: StateSensorConfig = { name: "車庫門", classes: ["關", "開"], crop: [0.2, 0.2, 0.8, 0.9], threshold: 0.8, intervalSec: 10, onMotion: true, enabled: true };
      const s = createSensor(second.id, config, t - 20 * MIN);
      const r = rng(23);
      for (let i = 0; i < 6; i++) s.images.push(newImage(r() < 0.5 ? 0 : 1, null, "recording", t - 20 * MIN + i * 1000, null));
    }
  }
  seed();

  // ---------- HTTP ----------
  function handle(req: MockStatesRequest): Response | null {
    const { path, method, url, body, admin } = req;
    if (!path.startsWith("/states") && !path.startsWith("/state-changes")) return null;
    const mutating = method !== "GET";
    if (mutating && !admin) return err(403, "需要管理員權限");

    if (path === "/states" && method === "GET") {
      const cameraId = url.searchParams.get("cameraId");
      return json([...sensors.values()].filter((s) => !cameraId || s.cameraId === cameraId).map(dto));
    }
    if (path === "/states" && method === "POST") {
      if (!isRecord(body)) return err(400, "請求格式不正確");
      const cam = typeof body.cameraId === "string" ? camOf(body.cameraId as CameraId) : undefined;
      if (!cam) return err(400, "找不到這台攝影機");
      const parsed = parseConfig(body.config, null);
      if (!parsed.ok) return err(400, parsed.error);
      const s = createSensor(cam.id, parsed.value);
      if (body.collect !== false) runCollect(s);
      emitSensor(s);
      return json(dto(s), 201);
    }
    if (path === "/states/frigate-config" && method === "POST") {
      if (!isRecord(body) || typeof body.yaml !== "string" || !body.yaml.trim()) return err(400, "請貼上 Frigate 設定檔的內容");
      const result = parseFrigate(body.yaml);
      return result.ok ? json(result.value) : err(400, result.error);
    }

    if (path === "/state-changes" && method === "GET") {
      const q = url.searchParams;
      const limit = Math.min(500, Math.max(1, Number(q.get("limit")) || 50));
      const before = q.has("before") ? Number(q.get("before")) : Infinity;
      const list = changes
        .map((c) => c.dto)
        .filter((c) => (!q.get("sensorId") || c.sensorId === q.get("sensorId")) && (!q.get("cameraId") || c.cameraId === q.get("cameraId")) && c.at < before)
        .sort((a, b) => b.at - a.at || b.id - a.id)
        .slice(0, limit);
      return json(list);
    }
    const thumb = path.match(/^\/state-changes\/(\d+)\/thumb\.jpg$/);
    if (thumb && method === "GET") {
      const c = changes.find((x) => x.dto.id === Number(thumb[1]));
      return c ? svgResponse(c.look, c.dto.id * 131) : err(404, "找不到這筆紀錄");
    }

    const m = path.match(/^\/states\/([^/]+)(?:\/(.+))?$/);
    if (!m) return err(404, "找不到路徑");
    const s = sensors.get(m[1]!);
    if (!s) return err(404, "找不到這個感應器");
    const sub = m[2] ?? "";

    if (sub === "" && method === "GET") return json(dto(s));
    if (sub === "" && method === "PUT") {
      const parsed = parseConfig(isRecord(body) ? body.config : undefined, s.config);
      if (!parsed.ok) return err(400, parsed.error);
      const gone = s.config.classes.filter((c) => !parsed.value.classes.includes(c));
      for (const img of s.images) if (img.label && gone.includes(img.label)) img.label = null;
      s.config = parsed.value;
      if (problemOf(s)) resetRecognition(s);
      emitSensor(s);
      return json(dto(s));
    }
    if (sub === "" && method === "DELETE") {
      if (s.jobTimer) clearInterval(s.jobTimer);
      sensors.delete(s.id);
      for (let i = changes.length - 1; i >= 0; i--) if (changes[i]!.dto.sensorId === s.id) changes.splice(i, 1);
      deps.emit({ type: "state-sensor-removed", data: { id: s.id } });
      return new Response(null, { status: 204 });
    }

    if (sub === "classes/rename" && method === "POST") {
      if (!isRecord(body) || typeof body.from !== "string" || typeof body.to !== "string") return err(400, "請求格式不正確");
      const { from, to } = body;
      if (!s.config.classes.includes(from)) return err(400, `沒有「${from}」這個類別`);
      const bad = classNameError(to);
      if (bad) return err(400, bad);
      if (to !== from && s.config.classes.includes(to)) return err(400, `已經有「${to}」這個類別了`);
      const swap = (c: string) => (c === from ? to : c);
      s.config = { ...s.config, classes: s.config.classes.map(swap) };
      for (const img of s.images) {
        if (img.label) img.label = swap(img.label);
        if (img.guess) img.guess = { ...img.guess, label: swap(img.guess.label) };
      }
      if (s.state) s.state = swap(s.state);
      if (s.candidate) s.candidate = { ...s.candidate, label: swap(s.candidate.label) };
      if (s.lastReading) s.lastReading = { ...s.lastReading, label: swap(s.lastReading.label) };
      if (s.model) {
        const v = s.model.validation;
        s.model = { ...s.model, classes: s.model.classes.map(swap), counts: s.model.counts.map((c) => ({ ...c, label: swap(c.label) })), validation: v && { ...v, perClass: v.perClass.map((p) => ({ ...p, label: swap(p.label) })) } };
      }
      for (const c of changes) if (c.dto.sensorId === s.id) c.dto = { ...c.dto, from: c.dto.from && swap(c.dto.from), to: swap(c.dto.to) };
      emitSensor(s);
      return json(dto(s));
    }

    if (sub === "collect" && method === "POST") {
      if (busy(s)) return err(409, "這個感應器正在忙，請等目前的工作完成");
      runCollect(s);
      return json(dto(s), 202);
    }
    if (sub === "train" && method === "POST") {
      if (busy(s)) return err(409, "這個感應器正在忙，請等目前的工作完成");
      if (!dto(s).trainable) return err(400, `每一類至少要有 ${MIN_STATE_IMAGES_PER_CLASS} 張已標記的圖片才能訓練`);
      runTrain(s);
      return json(dto(s), 202);
    }
    if (sub === "import" && method === "POST") {
      if (busy(s)) return err(409, "這個感應器正在忙，請等目前的工作完成");
      runImport(s);
      return json(dto(s), 202);
    }

    if (sub === "images" && method === "GET") {
      const label = url.searchParams.get("label") ?? "all";
      if (label !== "all" && label !== "pending" && !s.config.classes.includes(label)) return err(400, `沒有「${label}」這個類別`);
      const list = s.images.filter((i) => (label === "all" ? true : label === "pending" ? i.label === null : i.label === label)).sort((a, b) => b.createdAt - a.createdAt);
      return json(list.map((i) => imageDto(s, i)));
    }
    const one = sub.match(/^images\/([^/]+)$/);
    if (one && method === "GET") {
      const img = s.images.find((i) => i.id === one[1]);
      return img ? svgResponse(img.look, img.seed) : err(404, "找不到這張圖片");
    }
    if (sub === "images/label" && method === "POST") {
      if (!isRecord(body) || !Array.isArray(body.ids) || !body.ids.every((x) => typeof x === "string")) return err(400, "請求格式不正確");
      const label = body.label;
      if (label !== null && (typeof label !== "string" || !s.config.classes.includes(label))) return err(400, "標記的類別不在這個感應器的類別裡");
      const targets = s.images.filter((i) => (body.ids as string[]).includes(i.id));
      if (targets.length !== new Set(body.ids as string[]).size) return err(404, "有些圖片找不到");
      for (const img of targets) img.label = label;
      emitSensor(s);
      return json(dto(s));
    }
    if (sub === "images/delete" && method === "POST") {
      if (!isRecord(body) || !Array.isArray(body.ids) || !body.ids.every((x) => typeof x === "string")) return err(400, "請求格式不正確");
      const ids = new Set(body.ids as string[]);
      s.images = s.images.filter((i) => !ids.has(i.id));
      emitSensor(s);
      return json(dto(s));
    }
    return err(404, "找不到路徑");
  }

  return { sensors: () => [...sensors.values()].map(dto), handle };
}
