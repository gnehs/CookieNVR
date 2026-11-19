import type {
  CameraDto,
  HomekitActionDto,
  HomekitDto,
  CreatedTokenDto,
  EventDto,
  ExportDto,
  ExportRequestDto,
  InfoDto,
  LinkRequestDto,
  MeDto,
  ObjectsDto,
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
    throw new ApiError(0, "無法連線到伺服器");
  }
  if (res.status === 204) return undefined as T;
  let data: any = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    if (res.status === 401 && !quiet401) onUnauthorized();
    throw new ApiError(res.status, data?.error ?? `錯誤 ${res.status}`);
  }
  return data as T;
}

const get = <T>(p: string) => request<T>("GET", p);
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
  me: () => request<MeDto>("GET", "/me"),
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
  updateSettings: (patch: Partial<Omit<Settings, "objects">> & { objects?: Partial<ObjectSettings> }) => put<SettingsDto>("/settings", patch),
  cameras: () => get<CameraDto[]>("/cameras"),
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
    get<SegmentDto[]>(`/cameras/${encodeURIComponent(id)}/recordings?start=${start}&end=${end}`),
  segmentUrl: (id: number) => `/api/segments/${id}`,
  events: (camera: string, start: number, end: number) =>
    get<EventDto[]>(`/events?camera=${encodeURIComponent(camera)}&start=${start}&end=${end}`),
  /** 所有攝影機在這段時間內還沒結束的事件；事件最長 10 分鐘，since 往前抓 10 分鐘以上就不會漏 */
  activeEvents: (since: number, until: number) => get<EventDto[]>(`/events?start=${since}&end=${until}`).then((list) => list.filter((e) => e.endMs === null)),
  /** 開始時間早於 before 的事件，由新到舊；camera 為 null 時是所有攝影機 */
  eventsBefore: (before: number, limit: number, camera: string | null, label: string | null = null) =>
    get<EventDto[]>(`/events?before=${before}&limit=${limit}${camera ? `&camera=${encodeURIComponent(camera)}` : ""}${label ? `&label=${encodeURIComponent(label)}` : ""}`),
  objects: () => get<ObjectsDto>("/objects"),
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
    if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `錯誤 ${res.status}`);
    return res.text();
  },
  restartWorker: (id: string) => post<void>(`/system/workers/${encodeURIComponent(id)}/restart`),
};
