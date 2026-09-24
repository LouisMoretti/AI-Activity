// API response shapes shared by the server and the web client.
// Every numeric field is a measured value; missing data is null/absent,
// never interpolated.

export type Tool = "claude-code" | "codex" | "opencode";

export interface StatsResponse {
  range_days: number;
  tool: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  estimated_usd: number;
  events: number;
  sessions: number;
  has_data: boolean;
  provenance: string;
}

export interface ActivityDay {
  day: string; // YYYY-MM-DD (UTC)
  tokens: number;
  sessions: number;
}

export interface ActivityResponse {
  days: ActivityDay[];
  provenance: string;
}

export interface Quota {
  account_ref: string;
  tool: string;
  limit_type: string; // five_hour | seven_day | ...
  used_pct: number;
  resets_at: number | null;
  measured_at: number;
}

export interface QuotasResponse {
  quotas: Quota[];
  provenance: string;
}

export interface Session {
  session_id: string;
  tool: string;
  model: string | null;
  tokens: number;
  last_seen: number;
  events: number;
  /** Context fill at the latest call that reported it; null if never reported. */
  context_used_pct: number | null;
  context_window_size: number | null;
}

export interface SessionsResponse {
  sessions: Session[];
  total: number; // all sessions matching the filter, for "show more"
  provenance: string;
}

export interface BreakdownRow {
  name: string;
  tokens: number;
  sessions: number;
  events: number;
}

export interface Breakdown {
  tokens: number;
  sessions: number;
  events: number;
  by_model: BreakdownRow[];
  by_tool: BreakdownRow[];
}

export interface SummaryResponse {
  tool: string | null;
  day: string; // current UTC day, YYYY-MM-DD
  total: Breakdown; // all time
  today: Breakdown;
  provenance: string;
}

export interface Subscription {
  id: number;
  user_id: number;
  tool: string;
  plan_name: string;
  amount: number;
  currency: string;
  period_start: string | null;
  period_end: string | null;
  note: string | null;
  created_at: number;
}

export interface BillingRecord {
  id: number;
  user_id: number;
  kind: string; // api_actual | ...
  tool: string;
  amount: number;
  currency: string;
  period_start: string | null;
  period_end: string | null;
  source: string | null;
  note: string | null;
  created_at: number;
}

export interface BillingResponse {
  subscriptions: Subscription[];
  billing_records: BillingRecord[];
  estimated_api_equivalent_usd: number;
  /** false until at least one event carried a cost delta ("Unavailable", not 0). */
  estimated_available: boolean;
  disclaimer: string;
}

export interface Device {
  id: number;
  name: string;
  key_prefix: string;
  revoked: number;
  created_at: number;
}

export interface Account {
  id: number;
  username: string;
  display_name: string;
  is_admin: boolean;
}

/** An account as listed for admins. */
export interface AdminUser extends Account {
  disabled: boolean;
  created_at: number;
  /** Devices with a live (non-revoked) key. */
  devices: number;
}

export interface AuthStatus {
  /** False while no account exists: the dashboard is open. */
  locked: boolean;
  authenticated: boolean;
  /** The signed-in account; null when open or signed out. */
  user: Account | null;
}

export interface IngestResult {
  ok: true;
  deduped: boolean;
  stored: boolean;
  event_id: string;
}
