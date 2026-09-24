// Typed client for the dashboard JSON API (same origin, cookie session).
import type {
  Account, ActivityResponse, AdminOverview, AdminSettings, AdminUser, AuthStatus, Invite, Profile, ProfilesResponse, Device, QuotasResponse,
  SessionsResponse, StatsResponse, SummaryResponse,
} from "../../../shared/types.ts";

export class UnauthorizedError extends Error {
  constructor() { super("unauthorized"); }
}

export class NotFoundError extends Error {
  constructor() { super("not found"); }
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (r.status === 401) throw new UnauthorizedError();
  if (r.status === 404) throw new NotFoundError();
  if (!r.ok) throw new Error(`request failed: ${r.status}`);
  return r.json() as Promise<T>;
}

/** POST JSON; a non-2xx answer throws with the server's error message. */
async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 401) throw new UnauthorizedError();
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error || `request failed: ${r.status}`);
  return json as T;
}

/** What someone types to create their account. */
export interface NewAccount {
  username: string;
  display_name: string;
  password: string;
}

const toolQuery = (tool: string | null) => (tool ? `&tool=${encodeURIComponent(tool)}` : "");
const profileBase = (username: string) => `/api/u/${encodeURIComponent(username)}`;

export const api = {
  authStatus: () => get<AuthStatus>("/api/auth/status"),
  /** Resolves on success; throws with the server's message otherwise. */
  login: (username: string, password: string) => post<{ ok: true }>("/api/auth/login", { username, password }),
  logout: () => post<{ ok: true }>("/api/auth/logout"),
  /** First account, with the setup code from the server log; signs in. */
  setup: (setup_code: string, a: NewAccount) => post<{ ok: true }>("/api/auth/setup", { setup_code, ...a }),
  inviteStatus: (token: string) =>
    get<{ valid: boolean; expires_at: number | null }>(`/api/auth/invite/${encodeURIComponent(token)}`),
  /** Open sign-up from the sign-in page (when an admin allows it); signs in. */
  register: (a: NewAccount) => post<{ ok: true }>("/api/auth/register", a),
  adminOverview: () => get<AdminOverview>("/api/admin/overview"),
  adminSettings: () => get<AdminSettings>("/api/admin/settings"),
  setSignupOpen: (signup_open: boolean) => post<AdminSettings>("/api/admin/settings", { signup_open }),
  /** Account from an invite link; signs in. */
  signup: (invite: string, a: NewAccount) => post<{ ok: true }>("/api/auth/signup", { invite, ...a }),
  invites: () => get<{ invites: Invite[] }>("/api/users/invites"),
  createInvite: () => post<{ id: number; token: string; expires_at: number }>("/api/users/invites"),
  revokeInvite: (id: number) => post<{ ok: true }>(`/api/users/invites/${id}/revoke`),
  updateProfile: (display_name: string) => post<{ user: Account }>("/api/account", { display_name }),
  changePassword: (current_password: string, new_password: string) =>
    post<{ ok: true }>("/api/account/password", { current_password, new_password }),
  users: () => get<{ users: AdminUser[] }>("/api/users"),
  createUser: (u: { username: string; display_name: string; password: string; is_admin: boolean }) =>
    post<{ id: number }>("/api/users", u),
  setUserDisabled: (id: number, disabled: boolean) =>
    post<{ ok: true }>(`/api/users/${id}/${disabled ? "disable" : "enable"}`),
  resetPassword: (id: number, password: string) => post<{ ok: true }>(`/api/users/${id}/password`, { password }),
  profiles: () => get<ProfilesResponse>("/api/profiles"),
  stats: (days: number, tool: string | null) => get<StatsResponse>(`/api/stats?days=${days}${toolQuery(tool)}`),
  // A profile's usage, public by username (the viewer's own page uses it too).
  profile: (username: string) => get<Profile>(profileBase(username)),
  activity: (username: string, days: number, tool: string | null) =>
    get<ActivityResponse>(`${profileBase(username)}/activity?days=${days}${toolQuery(tool)}`),
  quotas: (username: string) => get<QuotasResponse>(`${profileBase(username)}/quotas`),
  summary: (username: string, tool: string | null) =>
    get<SummaryResponse>(`${profileBase(username)}/summary?x=1${toolQuery(tool)}`),
  sessions: (username: string, limit: number, tool: string | null, offset: number) =>
    get<SessionsResponse>(`${profileBase(username)}/sessions?limit=${limit}&offset=${offset}${toolQuery(tool)}`),
  devices: () => get<{ devices: Device[] }>("/api/devices"),
  /** The full key is only ever returned here, once. */
  createDevice: (name: string) => post<{ id: number; key: string }>("/api/devices", { name }),
  revokeDevice: (id: number) => post<{ ok: true }>(`/api/devices/${id}/revoke`),
};
