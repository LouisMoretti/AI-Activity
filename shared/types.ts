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
  /** https link to the profile picture (allowlisted hosts), or null. */
  avatar_url: string | null;
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
  authenticated: boolean;
  /** The signed-in account; null when signed out. */
  user: Account | null;
  /** No account exists yet: the first one needs the setup code (or the CLI). */
  setup_required: boolean;
  /** Anyone may create an account from the sign-in page (an admin setting). */
  signup_open: boolean;
}

/** Server settings an admin changes from the admin panel. */
export interface AdminSettings {
  signup_open: boolean;
}

/** Admin panel overview (whole server, all accounts). */
export interface AdminOverview {
  accounts: number;
  disabled_accounts: number;
  /** Devices with a live (non-revoked) key. */
  devices: number;
  events: number;
  sessions: number;
  /** When the server last received usage, or null. */
  last_event_at: number | null;
}

/** A profile page anyone signed in can open (read-only usage). */
export interface Profile {
  username: string;
  display_name: string;
  avatar_url: string | null;
}

export interface ProfilesResponse {
  profiles: Profile[];
}

/** POST /api/ingest/<tool> with one flat event. */
export interface IngestResult {
  ok: true;
  /** A new message row was created. */
  stored: boolean;
  /** An already stored message got its final (larger) counts. */
  updated: boolean;
  /** Replay of a message already stored with these counts (or more). */
  deduped: boolean;
  /** The message id, or null when the payload carried no usage. */
  event_id: string | null;
}

/** POST /api/ingest/<tool> with { messages: [...] }. */
export interface IngestBatchResult {
  ok: true;
  /** Messages with a message id in the payload. */
  messages: number;
  stored: number;
  updated: number;
  deduped: number;
}

/** One account on the leaderboard (every enabled account, idle ones with zeros). */
export interface LeaderboardEntry {
  username: string;
  display_name: string;
  avatar_url: string | null;
  tokens: number;
  sessions: number;
  events: number;
  /** UTC days with at least one event in the period. */
  active_days: number;
  /** Model with the most tokens in the period; null if never reported. */
  top_model: string | null;
  /** Latest event in the period; null when idle. */
  last_active: number | null;
  /** Consecutive UTC days with usage ending today (same rule as a profile's streak). */
  current_streak: number;
}

/** Server-wide usage across every enabled account (public, like profile pages). */
export interface LeaderboardResponse {
  /** Period length; null = all time. */
  range_days: number | null;
  /** Enabled accounts, active or not (= entries.length). */
  accounts: number;
  totals: { tokens: number; sessions: number; events: number; active_accounts: number };
  /** Ranked by tokens, most first. */
  entries: LeaderboardEntry[];
  by_model: BreakdownRow[];
  /** Everyone's daily buckets over the last 364 UTC days, whatever the period. */
  activity: ActivityDay[];
  provenance: string;
}
