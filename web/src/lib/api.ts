// Typed client for the dashboard JSON API (same origin, cookie session).
import type {
  ActivityResponse, AuthStatus, BillingResponse, QuotasResponse,
  SessionsResponse, StatsResponse, SummaryResponse,
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

const toolQuery = (tool: string | null) => (tool ? `&tool=${encodeURIComponent(tool)}` : "");

export const api = {
  authStatus: () => get<AuthStatus>("/api/auth/status"),
  async login(password: string): Promise<boolean> {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    return r.ok;
  },
  stats: (days: number, tool: string | null) => get<StatsResponse>(`/api/stats?days=${days}${toolQuery(tool)}`),
  activity: (days: number, tool: string | null) => get<ActivityResponse>(`/api/activity?days=${days}${toolQuery(tool)}`),
  quotas: () => get<QuotasResponse>("/api/quotas"),
  summary: (tool: string | null) => get<SummaryResponse>(`/api/summary?x=1${toolQuery(tool)}`),
  sessions: (limit: number, tool: string | null) =>
    get<SessionsResponse>(`/api/sessions?limit=${limit}${toolQuery(tool)}`),
  billing: () => get<BillingResponse>("/api/billing"),
};
