import type {
  CameraDto,
  CreatedTokenDto,
  InfoDto,
  MeDto,
  ProbeResult,
  SegmentDto,
  SessionDto,
  SettingsDto,
  SystemDto,
  TokenDto,
  UserDto,
} from "../src/api-types.ts";
import type { CameraConfig, CameraConnection, Role, Settings } from "../src/types.ts";

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
  users: () => get<UserDto[]>("/users"),
  createUser: (username: string, password: string, role: Role) =>
    post<UserDto>("/users", { username, password, role }),
  updateUser: (id: number, patch: { role?: Role; password?: string }) => put<UserDto>(`/users/${id}`, patch),
  deleteUser: (id: number) => del(`/users/${id}`),
  settings: () => get<SettingsDto>("/settings"),
  updateSettings: (patch: Partial<Settings>) => put<SettingsDto>("/settings", patch),
  cameras: () => get<CameraDto[]>("/cameras"),
  createCamera: (config: CameraConfig) => post<CameraDto>("/cameras", config),
  updateCamera: (id: string, config: CameraConfig) => put<CameraDto>(`/cameras/${encodeURIComponent(id)}`, config),
  deleteCamera: (id: string) => del(`/cameras/${encodeURIComponent(id)}`),
  testCamera: (connection: CameraConnection) => post<ProbeResult>("/cameras/test", connection),
  days: (id: string, tz: string) =>
    get<string[]>(`/cameras/${encodeURIComponent(id)}/days?tz=${encodeURIComponent(tz)}`),
  recordings: (id: string, start: number, end: number) =>
    get<SegmentDto[]>(`/cameras/${encodeURIComponent(id)}/recordings?start=${start}&end=${end}`),
  segmentUrl: (id: number) => `/api/segments/${id}`,
  system: () => get<SystemDto>("/system"),
  restartWorker: (id: string) => post<void>(`/system/workers/${encodeURIComponent(id)}/restart`),
};
