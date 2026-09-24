// Typed client for the dashboard JSON API (same origin, cookie session).
import type {
  Account, ActivityResponse, AdminUser, AuthStatus, BillingResponse, Device, QuotasResponse,
  SessionsResponse, StatsResponse, Subscription, SummaryResponse,
} from "../../../shared/types.ts";

export class UnauthorizedError extends Error {
  constructor() { super("unauthorized"); }
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (r.status === 401) throw new UnauthorizedError();
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

export type NewSubscription =
  Pick<Subscription, "tool" | "plan_name" | "amount" | "currency" | "period_start" | "period_end" | "note">;

const toolQuery = (tool: string | null) => (tool ? `&tool=${encodeURIComponent(tool)}` : "");

export const api = {
  authStatus: () => get<AuthStatus>("/api/auth/status"),
  /** Resolves on success; throws with the server's message otherwise. */
  login: (username: string, password: string) => post<{ ok: true }>("/api/auth/login", { username, password }),
  logout: () => post<{ ok: true }>("/api/auth/logout"),
  updateProfile: (display_name: string) => post<{ user: Account }>("/api/account", { display_name }),
  changePassword: (current_password: string, new_password: string) =>
    post<{ ok: true }>("/api/account/password", { current_password, new_password }),
  users: () => get<{ users: AdminUser[] }>("/api/users"),
  createUser: (u: { username: string; display_name: string; password: string; is_admin: boolean }) =>
    post<{ id: number }>("/api/users", u),
  setUserDisabled: (id: number, disabled: boolean) =>
    post<{ ok: true }>(`/api/users/${id}/${disabled ? "disable" : "enable"}`),
  resetPassword: (id: number, password: string) => post<{ ok: true }>(`/api/users/${id}/password`, { password }),
  stats: (days: number, tool: string | null) => get<StatsResponse>(`/api/stats?days=${days}${toolQuery(tool)}`),
  activity: (days: number, tool: string | null) => get<ActivityResponse>(`/api/activity?days=${days}${toolQuery(tool)}`),
  quotas: () => get<QuotasResponse>("/api/quotas"),
  summary: (tool: string | null) => get<SummaryResponse>(`/api/summary?x=1${toolQuery(tool)}`),
  sessions: (limit: number, tool: string | null, offset = 0) =>
    get<SessionsResponse>(`/api/sessions?limit=${limit}&offset=${offset}${toolQuery(tool)}`),
  billing: () => get<BillingResponse>("/api/billing"),
  devices: () => get<{ devices: Device[] }>("/api/devices"),
  /** The full key is only ever returned here, once. */
  createDevice: (name: string) => post<{ id: number; key: string }>("/api/devices", { name }),
  revokeDevice: (id: number) => post<{ ok: true }>(`/api/devices/${id}/revoke`),
  addSubscription: (s: NewSubscription) => post<{ id: number }>("/api/billing/subscription", s),
};
