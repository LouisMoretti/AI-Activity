import { createHash, randomUUID } from "node:crypto";
import type {
  Account, ActivityDay, AdminOverview, AdminUser, Profile, Breakdown, BreakdownRow, Device, LeaderboardEntry,
  LeaderboardResponse, Quota, Session,
} from "../../shared/types.ts";
import { nowSec, type DB } from "./schema.ts";

export interface DeviceRow extends Device {
  user_id: number;
  key_hash: string;
}

export interface UsageEventInput {
  event_id: string;
  device_id: number;
  user_id: number;
  tool: string;
  session_id: string | null;
  prompt_id: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  context_window_size: number | null;
  context_used_pct: number | null;
  occurred_at: number;
  received_at: number;
}

export interface QuotaSnapshotInput {
  device_id: number;
  user_id: number;
  account_ref: string;
  tool: string;
  limit_type: string;
  used_pct: number;
  resets_at: number | null;
  measured_at: number;
}

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  events: number;
  sessions: number;
}

export function hashKey(rawKey: string): string {
  return createHash("sha256").update(String(rawKey)).digest("hex");
}

export function getDefaultUserId(db: DB): number {
  return (db.prepare("SELECT id FROM users ORDER BY id LIMIT 1").get() as { id: number }).id;
}

export interface UserRow {
  id: number;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  password_hash: string | null;
  is_admin: number;
  disabled: number;
}

export function toAccount(u: UserRow): Account {
  return {
    id: u.id,
    username: u.username ?? "",
    display_name: u.display_name || u.username || "",
    avatar_url: u.avatar_url,
    is_admin: Boolean(u.is_admin),
  };
}

export function toProfile(u: UserRow): Profile {
  const { username, display_name, avatar_url } = toAccount(u);
  return { username, display_name, avatar_url };
}

/** True once at least one account can log in; before that nothing is viewable (setup). */
export function accountsExist(db: DB): boolean {
  return Boolean(db.prepare("SELECT 1 FROM users WHERE password_hash IS NOT NULL LIMIT 1").get());
}

export function findUserByUsername(db: DB, username: string): UserRow | null {
  return (db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username) as UserRow | undefined)
    ?? null;
}

export function listUsers(db: DB): UserRow[] {
  return db.prepare("SELECT * FROM users WHERE username IS NOT NULL ORDER BY id").all() as UserRow[];
}

/** Accounts that can sign in, i.e. whose profile page exists. */
export function listProfiles(db: DB): Profile[] {
  return (db
    .prepare("SELECT * FROM users WHERE password_hash IS NOT NULL AND disabled = 0 ORDER BY username COLLATE NOCASE")
    .all() as UserRow[]).map(toProfile);
}

export function getUser(db: DB, id: number): UserRow | null {
  return (db.prepare("SELECT * FROM users WHERE id = ? AND username IS NOT NULL").get(id) as UserRow | undefined) ?? null;
}

/** Accounts as the admin panel shows them, with their device count. */
export function listAdminUsers(db: DB): AdminUser[] {
  const rows = db
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.revoked = 0) AS devices
       FROM users u WHERE u.username IS NOT NULL ORDER BY u.id`
    )
    .all() as (UserRow & { created_at: number; devices: number })[];
  return rows.map((u) => ({ ...toAccount(u), disabled: Boolean(u.disabled), created_at: u.created_at, devices: u.devices }));
}

export function setDisplayName(db: DB, userId: number, name: string | null): void {
  db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(name, userId);
}

export function setAvatarUrl(db: DB, userId: number, url: string | null): void {
  db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").run(url, userId);
}

export function setUserAdmin(db: DB, userId: number, isAdmin: boolean): void {
  db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(isAdmin ? 1 : 0, userId);
}

export function setUserDisabled(db: DB, userId: number, disabled: boolean): void {
  db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, userId);
}

/**
 * Create a login account. The very first account claims the pre-accounts
 * user (the one that already owns every device and event) instead of
 * starting empty.
 */
export function createAccount(
  db: DB,
  a: { username: string; display_name: string | null; password_hash: string; is_admin: boolean }
): number {
  return db.transaction(() => {
    const unclaimed = accountsExist(db) ? undefined : db
      .prepare("SELECT id FROM users WHERE username IS NULL ORDER BY id LIMIT 1")
      .get() as { id: number } | undefined;
    if (unclaimed) {
      db.prepare(
        "UPDATE users SET username = ?, display_name = ?, password_hash = ?, is_admin = ? WHERE id = ?"
      ).run(a.username, a.display_name, a.password_hash, a.is_admin ? 1 : 0, unclaimed.id);
      return unclaimed.id;
    }
    const info = db.prepare(
      "INSERT INTO users (username, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(a.username, a.display_name, a.password_hash, a.is_admin ? 1 : 0, nowSec());
    return Number(info.lastInsertRowid);
  })();
}

/** Whether anyone may create an account from the sign-in page (open unless an admin closed it). */
export function signupOpen(db: DB): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'signup_open'").get() as { value: string } | undefined;
  return row?.value !== "0";
}

export function setSignupOpen(db: DB, open: boolean): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('signup_open', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(open ? "1" : "0");
}

/** Counts for the admin overview. */
export function adminOverview(db: DB): AdminOverview {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number | null }).n ?? 0;
  return {
    accounts: n("SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL"),
    disabled_accounts: n("SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL AND disabled = 1"),
    devices: n("SELECT COUNT(*) AS n FROM devices WHERE revoked = 0"),
    events: n("SELECT COUNT(*) AS n FROM usage_events"),
    sessions: n("SELECT COUNT(DISTINCT session_id) AS n FROM usage_events"),
    last_event_at: (db.prepare("SELECT MAX(received_at) AS n FROM usage_events").get() as { n: number | null }).n,
  };
}

/** Create the first account only; null when one already exists (lost race). */
export function createFirstAccount(db: DB, a: Parameters<typeof createAccount>[1]): number | null {
  return db.transaction(() => (accountsExist(db) ? null : createAccount(db, a)))();
}

export function setPasswordHash(db: DB, userId: number, hash: string): void {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
}

export function insertViewerSession(db: DB, tokenHash: string, userId: number, expiresAt: number): void {
  const now = nowSec();
  db.prepare("DELETE FROM viewer_sessions WHERE expires_at <= ?").run(now);
  db.prepare(
    "INSERT INTO viewer_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).run(tokenHash, userId, expiresAt, now);
}

/** The user behind a live session; expired sessions and disabled users get null. */
export function viewerSessionUser(db: DB, tokenHash: string): UserRow | null {
  return (db
    .prepare(
      `SELECT u.* FROM viewer_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0 AND u.password_hash IS NOT NULL`
    )
    .get(tokenHash, nowSec()) as UserRow | undefined) ?? null;
}

export function deleteViewerSession(db: DB, tokenHash: string): void {
  db.prepare("DELETE FROM viewer_sessions WHERE token_hash = ?").run(tokenHash);
}

/** Sign a user out everywhere, optionally keeping one session. */
export function deleteUserSessions(db: DB, userId: number, keepTokenHash: string | null = null): void {
  db.prepare("DELETE FROM viewer_sessions WHERE user_id = ? AND token_hash IS NOT ?").run(userId, keepTokenHash);
}

export function findDeviceByKey(db: DB, rawKey: string | null): DeviceRow | null {
  if (!rawKey) return null;
  // A disabled account's devices stop being accepted too.
  const row = db
    .prepare(
      `SELECT d.* FROM devices d JOIN users u ON u.id = d.user_id
       WHERE d.key_hash = ? AND u.disabled = 0`
    )
    .get(hashKey(rawKey)) as DeviceRow | undefined;
  if (!row || row.revoked) return null;
  return row;
}

export function createDevice(db: DB, { userId, name }: { userId: number; name: string }) {
  const raw = `ak_${randomUUID().replace(/-/g, "")}`;
  const prefix = raw.slice(0, 10);
  const info = db
    .prepare(
      "INSERT INTO devices (user_id, name, key_hash, key_prefix, revoked, created_at) VALUES (?, ?, ?, ?, 0, ?)"
    )
    .run(userId, name || "unnamed device", hashKey(raw), prefix, nowSec());
  return { id: Number(info.lastInsertRowid), key: raw, prefix };
}

/** Revoke one of the user's devices; false when no such device exists. */
export function revokeDevice(db: DB, userId: number, id: number): boolean {
  return db.prepare("UPDATE devices SET revoked = 1 WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

export function listDevices(db: DB, userId: number): Device[] {
  return db
    .prepare("SELECT id, name, key_prefix, revoked, created_at FROM devices WHERE user_id = ? ORDER BY id")
    .all(userId) as Device[];
}

export type UpsertResult = "stored" | "updated" | "deduped";

/**
 * Store one message's consumption, keyed by its Anthropic message id
 * (event_id). Claude Code writes a response in several transcript entries,
 * sometimes a partial one (a few output tokens) before the final one, so a
 * message seen again with more output tokens replaces the stored counts;
 * anything else is a replay. A message id already owned by another account
 * is never touched.
 */
export function upsertUsageEvent(db: DB, ev: UsageEventInput): UpsertResult {
  return db.transaction((): UpsertResult => {
    const existing = db
      .prepare("SELECT user_id, output_tokens FROM usage_events WHERE event_id = ?")
      .get(ev.event_id) as { user_id: number; output_tokens: number } | undefined;
    if (!existing) {
      db.prepare(
        `INSERT INTO usage_events
          (event_id, device_id, user_id, tool, session_id, prompt_id, model,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           context_window_size, context_used_pct, occurred_at, received_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'message')`
      ).run(
        ev.event_id, ev.device_id, ev.user_id, ev.tool, ev.session_id, ev.prompt_id, ev.model,
        ev.input_tokens, ev.output_tokens, ev.cache_read_tokens, ev.cache_write_tokens,
        ev.context_window_size, ev.context_used_pct, ev.occurred_at, ev.received_at
      );
      return "stored";
    }
    if (existing.user_id !== ev.user_id || ev.output_tokens <= existing.output_tokens) return "deduped";
    db.prepare(
      `UPDATE usage_events SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
         cache_write_tokens = ?, model = COALESCE(?, model), received_at = ?
       WHERE event_id = ?`
    ).run(
      ev.input_tokens, ev.output_tokens, ev.cache_read_tokens, ev.cache_write_tokens,
      ev.model, ev.received_at, ev.event_id
    );
    return "updated";
  })();
}

/**
 * Drop a session's old statusLine snapshot rows from sinceSec on, once its
 * messages from that time arrive: the messages are exact, the snapshots
 * counted most calls twice, and the two must never add up. Older snapshot
 * rows stay until messages cover them too (the live collector only resends
 * the transcript tail; the README import covers whole sessions).
 */
export function dropSnapshotRows(db: DB, userId: number, sessionId: string, sinceSec: number): number {
  return db
    .prepare("DELETE FROM usage_events WHERE user_id = ? AND session_id = ? AND source = 'snapshot' AND occurred_at >= ?")
    .run(userId, sessionId, sinceSec).changes;
}

/** Put the session's latest context fill on its newest row (a gauge, never summed). */
export function setSessionContext(
  db: DB, userId: number, sessionId: string, usedPct: number | null, windowSize: number | null
): void {
  db.prepare(
    `UPDATE usage_events SET context_used_pct = COALESCE(?, context_used_pct),
       context_window_size = COALESCE(?, context_window_size)
     WHERE event_id = (
       SELECT event_id FROM usage_events WHERE user_id = ? AND session_id = ?
       ORDER BY occurred_at DESC, received_at DESC LIMIT 1
     )`
  ).run(usedPct, windowSize, userId, sessionId);
}

/**
 * Record a quota snapshot. The statusLine re-sends the same window values on
 * every fire, so an unchanged value (same used_pct and resets_at as the
 * latest row) only moves that row's measured_at forward instead of adding
 * a new row.
 */
export function insertQuotaSnapshot(db: DB, q: QuotaSnapshotInput): void {
  const latest = db
    .prepare(
      `SELECT id, used_pct, resets_at FROM quota_snapshots
       WHERE user_id = ? AND account_ref = ? AND limit_type = ?
       ORDER BY measured_at DESC, id DESC LIMIT 1`
    )
    .get(q.user_id, q.account_ref, q.limit_type) as
    { id: number; used_pct: number; resets_at: number | null } | undefined;
  if (latest && latest.used_pct === q.used_pct && latest.resets_at === q.resets_at) {
    db.prepare("UPDATE quota_snapshots SET measured_at = MAX(measured_at, ?) WHERE id = ?")
      .run(q.measured_at, latest.id);
    return;
  }
  db.prepare(
    `INSERT INTO quota_snapshots
      (device_id, user_id, account_ref, tool, limit_type, used_pct, resets_at, measured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(q.device_id, q.user_id, q.account_ref, q.tool, q.limit_type, q.used_pct, q.resets_at, q.measured_at);
}

/**
 * Latest snapshot per (account_ref, limit_type). Never summed across devices.
 * measured_at has 1 s resolution and the statusLine fires in bursts, so ties
 * are broken by insertion order (id) to always return exactly one row.
 */
export function latestQuotas(db: DB, userId: number): Quota[] {
  return db
    .prepare(
      `SELECT account_ref, tool, limit_type, used_pct, resets_at, measured_at FROM (
         SELECT q.*, ROW_NUMBER() OVER (
           PARTITION BY account_ref, limit_type
           ORDER BY measured_at DESC, id DESC
         ) AS rn
         FROM quota_snapshots q WHERE user_id = ?
       ) WHERE rn = 1
       ORDER BY account_ref, limit_type`
    )
    .all(userId) as Quota[];
}

export function usageTotals(db: DB, userId: number, sinceSec: number, tool: string | null): UsageTotals {
  return db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
         COALESCE(SUM(cache_write_tokens), 0) AS cache_write,
         COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS total_tokens,
         COUNT(*) AS events,
         COUNT(DISTINCT session_id) AS sessions
       FROM usage_events
       WHERE user_id = ? AND occurred_at >= ?
         AND (? IS NULL OR tool = ?)`
    )
    .get(userId, sinceSec, tool, tool) as UsageTotals;
}

export function dailyBuckets(db: DB, userId: number, sinceSec: number, tool: string | null): ActivityDay[] {
  return db
    .prepare(
      `SELECT
         date(occurred_at, 'unixepoch') AS day,
         SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens,
         COUNT(DISTINCT session_id) AS sessions
       FROM usage_events
       WHERE user_id = ? AND occurred_at >= ?
         AND (? IS NULL OR tool = ?)
       GROUP BY day ORDER BY day`
    )
    .all(userId, sinceSec, tool, tool) as ActivityDay[];
}

const TOKENS = "input_tokens + output_tokens + cache_read_tokens + cache_write_tokens";

/**
 * Most recent sessions. Model and context fill come from the session's
 * latest event that reported them (the model in use now, not MAX(model) by
 * string order; context is a gauge at that moment, never summed). Both are
 * looked up for the page's sessions only.
 */
export function recentSessions(
  db: DB, userId: number, limit: number, tool: string | null, offset = 0
): Session[] {
  const latest = (col: string, where: string) =>
    `(SELECT ${col} FROM usage_events m
      WHERE m.user_id = s.user_id AND m.session_id = s.session_id AND m.tool = s.tool AND ${where}
      ORDER BY m.occurred_at DESC, m.received_at DESC LIMIT 1)`;
  return db
    .prepare(
      `SELECT s.session_id, s.tool, s.tokens, s.last_seen, s.events,
         ${latest("model", "m.model IS NOT NULL")} AS model,
         ${latest("context_used_pct", "m.context_used_pct IS NOT NULL")} AS context_used_pct,
         ${latest("context_window_size", "m.context_used_pct IS NOT NULL")} AS context_window_size
       FROM (
         SELECT user_id, session_id, tool,
                SUM(${TOKENS}) AS tokens,
                MAX(occurred_at) AS last_seen, COUNT(*) AS events
         FROM usage_events
         WHERE user_id = ? AND session_id IS NOT NULL AND (? IS NULL OR tool = ?)
         GROUP BY session_id, tool
         ORDER BY last_seen DESC, session_id LIMIT ? OFFSET ?
       ) s
       ORDER BY s.last_seen DESC, s.session_id`
    )
    .all(userId, tool, tool, limit, offset) as Session[];
}

export function countSessions(db: DB, userId: number, tool: string | null): number {
  return (db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM usage_events
         WHERE user_id = ? AND session_id IS NOT NULL AND (? IS NULL OR tool = ?)
         GROUP BY session_id, tool
       )`
    )
    .get(userId, tool, tool) as { n: number }).n;
}

type Tally = { tokens: number; events: number; sessions: Set<string> };
const tally = (): Tally => ({ tokens: 0, events: 0, sessions: new Set() });
const add = (t: Tally, tokens: number, events: number, session: string | null) => {
  t.tokens += tokens;
  t.events += events;
  if (session !== null) t.sessions.add(session);
};
/** Rows by tokens (largest first), sessions counted distinct like COUNT(DISTINCT). */
const ranked = (m: Map<string, Tally>): BreakdownRow[] =>
  [...m].map(([name, t]) => ({ name, tokens: t.tokens, sessions: t.sessions.size, events: t.events }))
    .sort((a, b) => b.tokens - a.tokens || (a.name < b.name ? -1 : 1));

/**
 * Tokens, sessions and events since sinceSec, split by model and by tool,
 * from one pass over the covering index (grouped per model, tool and
 * session, then folded here).
 */
export function breakdown(db: DB, userId: number, sinceSec: number, tool: string | null): Breakdown {
  const groups = db
    .prepare(
      `SELECT COALESCE(model, 'unknown') AS model, tool, session_id,
              SUM(${TOKENS}) AS tokens, COUNT(*) AS events
       FROM usage_events
       WHERE user_id = ? AND occurred_at >= ? AND (? IS NULL OR tool = ?)
       GROUP BY model, tool, session_id`
    )
    .all(userId, sinceSec, tool, tool) as { model: string; tool: string; session_id: string | null; tokens: number; events: number }[];
  const total = tally();
  const byModel = new Map<string, Tally>();
  const byTool = new Map<string, Tally>();
  for (const g of groups) {
    add(total, g.tokens, g.events, g.session_id);
    if (!byModel.has(g.model)) byModel.set(g.model, tally());
    add(byModel.get(g.model)!, g.tokens, g.events, g.session_id);
    if (!byTool.has(g.tool)) byTool.set(g.tool, tally());
    add(byTool.get(g.tool)!, g.tokens, g.events, g.session_id);
  }
  return {
    tokens: total.tokens,
    sessions: total.sessions.size,
    events: total.events,
    by_model: ranked(byModel),
    by_tool: ranked(byTool),
  };
}

/**
 * Everyone's usage since sinceSec, ranked by tokens. activitySinceSec bounds
 * the global heatmap and the streaks, which ignore the period. Disabled
 * accounts never appear. Two grouped passes over the covering index (the
 * period, and the heatmap year), folded here.
 */
export function leaderboard(
  db: DB, sinceSec: number, activitySinceSec: number, todayIso: string
): Omit<LeaderboardResponse, "range_days" | "provenance"> {
  // Every enabled account, used or not: idle ones rank last with zeros.
  const users = db
    .prepare(
      `SELECT id, username, display_name, avatar_url FROM users
       WHERE password_hash IS NOT NULL AND disabled = 0`
    )
    .all() as { id: number; username: string | null; display_name: string | null; avatar_url: string | null }[];
  const LISTED_FROM = `usage_events e JOIN users u ON u.id = e.user_id
    WHERE u.password_hash IS NOT NULL AND u.disabled = 0`;
  // The period, per user, session, model and day…
  const groups = db
    .prepare(
      `SELECT e.user_id, e.session_id, e.model, date(e.occurred_at, 'unixepoch') AS day,
              SUM(${TOKENS}) AS tokens, COUNT(*) AS events, MAX(e.occurred_at) AS last
       FROM ${LISTED_FROM} AND e.occurred_at >= ?
       GROUP BY e.user_id, e.session_id, e.model, day`
    )
    .all(sinceSec) as {
      user_id: number; session_id: string | null; model: string | null; day: string;
      tokens: number; events: number; last: number;
    }[];
  // …and the heatmap year, per user, day and session (models do not matter there).
  const yearDays = db
    .prepare(
      `SELECT e.user_id, date(e.occurred_at, 'unixepoch') AS day, e.session_id, SUM(${TOKENS}) AS tokens
       FROM ${LISTED_FROM} AND e.occurred_at >= ?
       GROUP BY e.user_id, day, e.session_id`
    )
    .all(activitySinceSec) as { user_id: number; day: string; session_id: string | null; tokens: number }[];

  type Acc = Tally & { days: Set<string>; last: number | null; models: Map<string, number>; streakDays: Set<string> };
  const acc = new Map<number, Acc>(users.map((u) => [u.id, {
    ...tally(), days: new Set<string>(), last: null, models: new Map<string, number>(), streakDays: new Set<string>(),
  }]));
  const total = tally();
  const byModel = new Map<string, Tally>();
  const activity = new Map<string, Tally>();
  for (const d of yearDays) {
    acc.get(d.user_id)!.streakDays.add(d.day);
    if (!activity.has(d.day)) activity.set(d.day, tally());
    add(activity.get(d.day)!, d.tokens, 0, d.session_id);
  }
  for (const g of groups) {
    const a = acc.get(g.user_id)!;
    add(a, g.tokens, g.events, g.session_id);
    add(total, g.tokens, g.events, g.session_id);
    a.days.add(g.day);
    a.last = Math.max(a.last ?? 0, g.last);
    if (g.model !== null) a.models.set(g.model, (a.models.get(g.model) ?? 0) + g.tokens);
    const name = g.model ?? "unknown";
    if (!byModel.has(name)) byModel.set(name, tally());
    add(byModel.get(name)!, g.tokens, g.events, g.session_id);
  }

  // Consecutive active days counted back from today.
  const streak = (days: Set<string>) => {
    let n = 0;
    for (let t = Date.parse(todayIso + "T00:00:00Z"); days.has(new Date(t).toISOString().slice(0, 10)); t -= 86400000) n++;
    return n;
  };
  // Most tokens, then the model name, like ORDER BY SUM(tokens) DESC, model.
  const topModel = (m: Map<string, number>) =>
    [...m].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0]?.[0] ?? null;
  // SQLite's NOCASE: ASCII letters folded, everything else by code point.
  const nocase = (v: string) => v.replace(/[A-Z]/g, (ch) => ch.toLowerCase());

  const entries = users.map((u) => {
    const a = acc.get(u.id)!;
    return {
      username: u.username ?? "",
      display_name: u.display_name || u.username || "",
      avatar_url: u.avatar_url,
      tokens: a.tokens,
      sessions: a.sessions.size,
      events: a.events,
      active_days: a.days.size,
      last_active: a.last,
      top_model: topModel(a.models),
      current_streak: streak(a.streakDays),
    };
  }).sort((x, y) => y.tokens - x.tokens || (nocase(x.username) < nocase(y.username) ? -1 : nocase(x.username) > nocase(y.username) ? 1 : 0));

  return {
    accounts: users.length,
    totals: {
      tokens: total.tokens, sessions: total.sessions.size, events: total.events,
      active_accounts: entries.filter((e) => e.events > 0).length,
    },
    entries,
    by_model: ranked(byModel),
    activity: [...activity].sort((x, y) => (x[0] < y[0] ? -1 : 1))
      .map(([day, t]) => ({ day, tokens: t.tokens, sessions: t.sessions.size })),
  };
}
