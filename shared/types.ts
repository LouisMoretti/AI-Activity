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
}

export interface SessionsResponse {
  sessions: Session[];
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
  disclaimer: string;
}

export interface Device {
  id: number;
  name: string;
  key_prefix: string;
  revoked: number;
  created_at: number;
}

export interface AuthStatus {
  locked: boolean;
  authenticated: boolean;
}

export interface IngestResult {
  ok: true;
  deduped: boolean;
  stored: boolean;
  event_id: string;
}
