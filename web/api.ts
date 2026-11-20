import { t } from "@lingui/core/macro";
import type {
  CameraDto,
  CameraGroupDto,
  CameraLayoutDto,
  HomekitActionDto,
  HomekitDto,
  CreatedTokenDto,
  EventDto,
  ExportDto,
  ExportRequestDto,
  InfoDto,
  LinkRequestDto,
  MeDto,
  ObjectLabelsDto,
  ObjectsDto,
  BenchmarkDto,
  VideoDevicesDto,
  ProbeResult,
  PtzCommandDto,
  PtzDto,
  PtzMoveResultDto,
  PtzPresetSavedDto,
  PtzPresetsDto,
  PtzRemovePresetDto,
  PtzSavePresetDto,
  PurgeDto,
  SegmentDto,
  SessionDto,
  SettingsDto,
  SystemDto,
  MetricsDto,
  TokenDto,
  UserDto,
  CreateStateSensorDto,
  FrigateConfigResultDto,
  StateChangeDto,
  StateImageDto,
  StateSensorConfigInput,
  StateSensorDto,
} from "../src/api-types.ts";
import type { CameraConfig, CameraConnection, ObjectSettings, Role, Settings } from "../src/types.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown, quiet401 = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, t`Unable to connect to the server`);
  }
  if (res.status === 204) return undefined as T;
  let data: any = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    if (res.status === 401 && !quiet401) onUnauthorized();
    const status = res.status;
    throw new ApiError(status, data?.error ?? t`Error ${status}`);
  }
  return data as T;
}

const get = <T>(p: string) => request<T>("GET", p);

/**
 * 伺服器的時間參數只收整數毫秒。播放器的時間由影片 currentTime 換算，常帶小數，
 * 在這裡往外取整（開始往前、結束往後），範圍只會變寬、不會漏掉邊上的東西。
 */
const range = (start: number, end: number) => `start=${Math.floor(start)}&end=${Math.ceil(end)}`;
const post = <T>(p: string, b?: unknown) => request<T>("POST", p, b ?? {});
const put = <T>(p: string, b: unknown) => request<T>("PUT", p, b);
const del = (p: string) => request<void>("DELETE", p);

export const api = {
  info: () => get<InfoDto>("/info"),
  setup: (username: string, password: string) =>
    request<MeDto>("POST", "/auth/setup", { username, password }, true),
  login: (username: string, password: string) =>
    request<MeDto>("POST", "/auth/login", { username, password }, true),
  logout: () => request<void>("POST", "/auth/logout", {}, true),
  /** quiet：開站時確認登入狀態用，401 不觸發登出處理 */
  me: (quiet = false) => request<MeDto>("GET", "/me", undefined, quiet),
  changePassword: (currentPassword: string, newPassword: string) =>
    put<void>("/me", { currentPassword, newPassword }),
  sessions: () => get<SessionDto[]>("/me/sessions"),
  revokeSession: (id: string) => del(`/me/sessions/${encodeURIComponent(id)}`),
  tokens: () => get<TokenDto[]>("/tokens"),
  createToken: (name: string) => post<CreatedTokenDto>("/tokens", { name }),
  revokeToken: (id: number) => del(`/tokens/${id}`),
  linkRequest: (code: string) => get<LinkRequestDto>(`/link/${encodeURIComponent(code)}`),
  decideLink: (code: string, decision: "approve" | "deny") =>
    post<LinkRequestDto>(`/link/${encodeURIComponent(code)}`, { decision }),
  users: () => get<UserDto[]>("/users"),
  createUser: (username: string, password: string, role: Role) =>
    post<UserDto>("/users", { username, password, role }),
  updateUser: (id: number, patch: { role?: Role; password?: string }) => put<UserDto>(`/users/${id}`, patch),
  deleteUser: (id: number) => del(`/users/${id}`),
  settings: () => get<SettingsDto>("/settings"),
  updateSettings: (patch: Partial<Omit<Settings, "objects" | "devices">> & { objects?: Partial<ObjectSettings>; devices?: Partial<Settings["devices"]> }) => put<SettingsDto>("/settings", patch),
  cameras: () => get<CameraDto[]>("/cameras"),
  cameraGroups: () => get<CameraGroupDto[]>("/camera-groups"),
  createCameraGroup: (name: string) => post<CameraGroupDto>("/camera-groups", { name }),
  renameCameraGroup: (id: string, name: string) => put<CameraGroupDto>(`/camera-groups/${encodeURIComponent(id)}`, { name }),
  deleteCameraGroup: (id: string) => del(`/camera-groups/${encodeURIComponent(id)}`),
  /** 一次排好分區順序與每台攝影機的分區、順序；回傳排好後的分區與攝影機 */
  arrangeCameras: (layout: CameraLayoutDto) => put<{ groups: CameraGroupDto[]; cameras: CameraDto[] }>("/camera-layout", layout),
  createCamera: (config: CameraConfig) => post<CameraDto>("/cameras", config),
  updateCamera: (id: string, config: CameraConfig) => put<CameraDto>(`/cameras/${encodeURIComponent(id)}`, config),
  deleteCamera: (id: string, deleteRecordings = false) =>
    del(`/cameras/${encodeURIComponent(id)}${deleteRecordings ? "?recordings=delete" : ""}`),
  purgeOrphanedRecordings: () => request<PurgeDto>("DELETE", "/recordings/orphaned"),
  testCamera: (connection: CameraConnection) => post<ProbeResult>("/cameras/test", connection),
  homekit: (id: string) => get<HomekitDto>(`/cameras/${encodeURIComponent(id)}/homekit`),
  homekitAction: (id: string, action: HomekitActionDto["action"]) =>
    post<HomekitDto>(`/cameras/${encodeURIComponent(id)}/homekit`, { action }),
  days: (id: string, tz: string) =>
    get<string[]>(`/cameras/${encodeURIComponent(id)}/days?tz=${encodeURIComponent(tz)}`),
  recordings: (id: string, start: number, end: number) =>
    get<SegmentDto[]>(`/cameras/${encodeURIComponent(id)}/recordings?${range(start, end)}`),
  segmentUrl: (id: number) => `/api/segments/${id}`,
  events: (camera: string, start: number, end: number) =>
    get<EventDto[]>(`/events?camera=${encodeURIComponent(camera)}&${range(start, end)}`),
  /** 所有攝影機在這段時間內還沒結束的事件；事件最長 10 分鐘，since 往前抓 10 分鐘以上就不會漏 */
  activeEvents: (since: number, until: number) => get<EventDto[]>(`/events?${range(since, until)}`).then((list) => list.filter((e) => e.endMs === null)),
  /** 開始時間早於 before 的事件，由新到舊；camera 為 null 時是所有攝影機 */
  /** labels：含任一類別的事件；空陣列不篩 */
  eventsBefore: (before: number, limit: number, camera: string | null, labels: readonly string[] = []) =>
    get<EventDto[]>(`/events?before=${Math.ceil(before)}&limit=${limit}${camera ? `&camera=${encodeURIComponent(camera)}` : ""}${labels.length ? `&label=${encodeURIComponent(labels.join(","))}` : ""}`),
  objects: () => get<ObjectsDto>("/objects"),
  objectLabels: () => get<ObjectLabelsDto>("/objects/labels"),
  startBenchmark: (devices?: string[]) => post<BenchmarkDto>("/objects/benchmark", devices ? { devices } : {}),
  cancelBenchmark: () => del("/objects/benchmark"),
  videoDevices: () => get<VideoDevicesDto>("/video-devices"),
  event: (id: number) => get<EventDto>(`/events/${id}`),
  deleteEvent: (id: number) => del(`/events/${id}`),
  eventThumbUrl: (id: number) => `/api/events/${id}/thumb.jpg`,
  motionUrl: (id: string) => `/api/cameras/${encodeURIComponent(id)}/motion`,
  snapshotUrl: (id: string, t: number) => `/api/cameras/${encodeURIComponent(id)}/snapshot.jpg?t=${t}`,
  exports: () => get<ExportDto[]>("/exports"),
  createExport: (req: ExportRequestDto) => post<ExportDto>("/exports", req),
  deleteExport: (id: string) => del(`/exports/${encodeURIComponent(id)}`),
  exportFileUrl: (id: string) => `/api/exports/${encodeURIComponent(id)}/file`,
  ptz: (id: string) => get<PtzDto>(`/cameras/${encodeURIComponent(id)}/ptz`),
  ptzMove: (id: string, move: Omit<Extract<PtzCommandDto, { action: "move" }>, "action">) =>
    post<PtzMoveResultDto>(`/cameras/${encodeURIComponent(id)}/ptz`, { action: "move", ...move }),
  ptzStop: (id: string) => post<void>(`/cameras/${encodeURIComponent(id)}/ptz`, { action: "stop" }),
  ptzGotoPreset: (id: string, token: string, speed?: number) =>
    post<void>(`/cameras/${encodeURIComponent(id)}/ptz`, { action: "preset", token, speed }),
  ptzSavePreset: (id: string, preset: PtzSavePresetDto) =>
    post<PtzPresetSavedDto>(`/cameras/${encodeURIComponent(id)}/ptz/presets`, preset),
  ptzRemovePreset: (id: string, preset: PtzRemovePresetDto) =>
    request<PtzPresetsDto>("DELETE", `/cameras/${encodeURIComponent(id)}/ptz/presets`, preset),
  system: () => get<SystemDto>("/system"),
  /** watch：狀態頁開著，後端才會讀 GPU 與各程序的用量 */
  metrics: (watch: boolean) => get<MetricsDto>(`/system/metrics${watch ? "?watch=1" : ""}`),
  diagnostics: async (camera?: string): Promise<string> => {
    const res = await fetch(`/api/system/diagnostics${camera ? `?camera=${encodeURIComponent(camera)}` : ""}`, { credentials: "same-origin" });
    if (!res.ok) {
      const status = res.status;
      throw new ApiError(status, ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? t`Error ${status}`);
    }
    return res.text();
  },
  restartWorker: (id: string) => post<void>(`/system/workers/${encodeURIComponent(id)}/restart`),
  states: () => get<StateSensorDto[]>("/states"),
  createState: (req: CreateStateSensorDto) => post<StateSensorDto>("/states", req),
  updateState: (id: string, config: StateSensorConfigInput) => put<StateSensorDto>(`/states/${encodeURIComponent(id)}`, { config }),
  deleteState: (id: string) => del(`/states/${encodeURIComponent(id)}`),
  renameStateClass: (id: string, from: string, to: string) => post<StateSensorDto>(`/states/${encodeURIComponent(id)}/classes/rename`, { from, to }),
  collectStateImages: (id: string) => post<StateSensorDto>(`/states/${encodeURIComponent(id)}/collect`),
  trainState: (id: string) => post<StateSensorDto>(`/states/${encodeURIComponent(id)}/train`),
  /** label：pending、all 或類別名稱 */
  stateImages: (id: string, label: string) =>
    get<{ images: StateImageDto[] }>(`/states/${encodeURIComponent(id)}/images?label=${encodeURIComponent(label)}`).then((r) => r.images),
  labelStateImages: (id: string, ids: string[], label: string | null) => post<StateSensorDto>(`/states/${encodeURIComponent(id)}/images/label`, { ids, label }),
  deleteStateImages: (id: string, ids: string[]) => post<StateSensorDto>(`/states/${encodeURIComponent(id)}/images/delete`, { ids }),
  stateChanges: (sensorId: string, limit: number) => get<StateChangeDto[]>(`/state-changes?sensorId=${encodeURIComponent(sensorId)}&limit=${limit}`),
  frigateConfig: (yaml: string) => post<FrigateConfigResultDto>("/states/frigate-config", { yaml }),
  /** 上傳 Frigate 匯出的資料集 zip；用 XHR 才拿得到上傳進度（0 到 1） */
  importStateDataset: (id: string, file: Blob, onProgress: (p: number) => void) =>
    new Promise<StateSensorDto>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/states/${encodeURIComponent(id)}/import`);
      xhr.setRequestHeader("content-type", "application/zip");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onerror = () => reject(new ApiError(0, t`Unable to connect to the server`));
      xhr.onload = () => {
        let data: any = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data as StateSensorDto);
        if (xhr.status === 401) onUnauthorized();
        const status = xhr.status;
        reject(new ApiError(status, data?.error ?? (status === 413 ? t`File too large (limit 100 MB)` : t`Error ${status}`)));
      };
      xhr.send(file);
    }),
};
