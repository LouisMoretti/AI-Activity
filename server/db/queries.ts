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
  // A snapshot is stamped when the statusLine fired, which can be up to about
  // a minute before the transcript's timestamp for the same API call.
  return db
    .prepare("DELETE FROM usage_events WHERE user_id = ? AND session_id = ? AND source = 'snapshot' AND occurred_at >= ?")
    .run(userId, sessionId, sinceSec - SNAPSHOT_SLACK_SEC).changes;
}

const SNAPSHOT_SLACK_SEC = 120;

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
 * Current value per (account_ref, limit_type). Never summed across devices.
 *
 * A device can post stale rate_limits (a second terminal that has not made
 * an API call yet), so "last posted" is not "current". Among the rows
 * measured in the day before the latest one, the window that resets last is
 * the current one, and within a window the usage only goes up: show its
 * highest percentage. The one-day bound keeps an old bogus far-future
 * resets_at from pinning a window forever.
 */
export function latestQuotas(db: DB, userId: number): Quota[] {
  return db
    .prepare(
      `WITH recent AS (
         SELECT q.*, MAX(measured_at) OVER (PARTITION BY account_ref, limit_type) AS last
         FROM quota_snapshots q WHERE user_id = ?
       ), live AS (
         SELECT *, MAX(COALESCE(resets_at, -1)) OVER (PARTITION BY account_ref, limit_type) AS win
         FROM recent WHERE measured_at >= last - 86400
       )
       SELECT account_ref, MAX(tool) AS tool, limit_type, MAX(used_pct) AS used_pct,
              resets_at, MAX(measured_at) AS measured_at
       FROM live WHERE COALESCE(resets_at, -1) = win
       GROUP BY account_ref, limit_type
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
 * string order; context is a gauge at that moment, never summed).
 */
export function recentSessions(
  db: DB, userId: number, limit: number, tool: string | null, offset = 0
): Session[] {
  return db
    .prepare(
      `SELECT s.*,
         (SELECT model FROM usage_events m
          WHERE m.user_id = ? AND m.session_id = s.session_id AND m.tool = s.tool
            AND m.model IS NOT NULL
          ORDER BY m.occurred_at DESC, m.received_at DESC LIMIT 1) AS model,
         c.context_used_pct, c.context_window_size FROM (
         SELECT session_id, tool,
                SUM(${TOKENS}) AS tokens,
                MAX(occurred_at) AS last_seen, COUNT(*) AS events
         FROM usage_events
         WHERE user_id = ? AND session_id IS NOT NULL AND (? IS NULL OR tool = ?)
         GROUP BY session_id, tool
         ORDER BY last_seen DESC, session_id LIMIT ? OFFSET ?
       ) s
       LEFT JOIN (
         SELECT session_id, tool, context_used_pct, context_window_size,
                ROW_NUMBER() OVER (
                  PARTITION BY session_id, tool ORDER BY occurred_at DESC, received_at DESC
                ) AS rn
         FROM usage_events
         WHERE user_id = ? AND context_used_pct IS NOT NULL
       ) c ON c.session_id = s.session_id AND c.tool = s.tool AND c.rn = 1
       ORDER BY s.last_seen DESC, s.session_id`
    )
    .all(userId, userId, tool, tool, limit, offset, userId) as Session[];
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

/** Tokens, sessions and events since sinceSec, split by model and by tool. */
export function breakdown(db: DB, userId: number, sinceSec: number, tool: string | null): Breakdown {
  const group = (col: "model" | "tool") =>
    db
      .prepare(
        `SELECT COALESCE(${col}, 'unknown') AS name,
                SUM(${TOKENS}) AS tokens,
                COUNT(DISTINCT session_id) AS sessions,
                COUNT(*) AS events
         FROM usage_events
         WHERE user_id = ? AND occurred_at >= ? AND (? IS NULL OR tool = ?)
         GROUP BY name ORDER BY tokens DESC`
      )
      .all(userId, sinceSec, tool, tool) as BreakdownRow[];
  const t = usageTotals(db, userId, sinceSec, tool);
  return {
    tokens: Number(t.total_tokens),
    sessions: Number(t.sessions),
    events: Number(t.events),
    by_model: group("model"),
    by_tool: group("tool"),
  };
}

/** Usage rows of enabled accounts only: disabled ones leave the leaderboard. */
const LISTED = `usage_events e JOIN users u ON u.id = e.user_id
  WHERE u.password_hash IS NOT NULL AND u.disabled = 0`;

/**
 * Everyone's usage since sinceSec, ranked by tokens. activitySinceSec bounds
 * the global heatmap and the streaks, which ignore the period.
 */
export function leaderboard(
  db: DB, sinceSec: number, activitySinceSec: number, todayIso: string
): Omit<LeaderboardResponse, "range_days" | "provenance"> {
  // Every enabled account, used or not: idle ones rank last with zeros.
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_url,
              COALESCE(SUM(${TOKENS}), 0) AS tokens,
              COUNT(DISTINCT e.session_id) AS sessions,
              COUNT(e.event_id) AS events,
              COUNT(DISTINCT date(e.occurred_at, 'unixepoch')) AS active_days,
              MAX(e.occurred_at) AS last_active
       FROM users u LEFT JOIN usage_events e ON e.user_id = u.id AND e.occurred_at >= ?
       WHERE u.password_hash IS NOT NULL AND u.disabled = 0
       GROUP BY u.id
       ORDER BY tokens DESC, u.username COLLATE NOCASE`
    )
    .all(sinceSec) as (Omit<LeaderboardEntry, "top_model" | "current_streak" | "display_name" | "avatar_url"> &
      { id: number; display_name: string | null; avatar_url: string | null })[];

  const topModels = new Map(
    (db
      .prepare(
        `SELECT user_id, model FROM (
           SELECT e.user_id, e.model, ROW_NUMBER() OVER (
             PARTITION BY e.user_id ORDER BY SUM(${TOKENS}) DESC, e.model
           ) AS rn
           FROM ${LISTED} AND e.occurred_at >= ? AND e.model IS NOT NULL
           GROUP BY e.user_id, e.model
         ) WHERE rn = 1`
      )
      .all(sinceSec) as { user_id: number; model: string }[]).map((r) => [r.user_id, r.model])
  );

  // Active days per user, newest first, to count back from today.
  const daysByUser = new Map<number, string[]>();
  for (const r of db
    .prepare(
      `SELECT DISTINCT e.user_id, date(e.occurred_at, 'unixepoch') AS day
       FROM ${LISTED} AND e.occurred_at >= ? ORDER BY day DESC`
    )
    .all(activitySinceSec) as { user_id: number; day: string }[]) {
    const list = daysByUser.get(r.user_id) ?? [];
    list.push(r.day);
    daysByUser.set(r.user_id, list);
  }
  const streak = (days: string[] = []) => {
    let n = 0;
    let expected = Date.parse(todayIso + "T00:00:00Z");
    for (const d of days) {
      if (Date.parse(d + "T00:00:00Z") !== expected) break;
      n++;
      expected -= 86400000;
    }
    return n;
  };

  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(${TOKENS}), 0) AS tokens, COUNT(DISTINCT e.session_id) AS sessions, COUNT(*) AS events
       FROM ${LISTED} AND e.occurred_at >= ?`
    )
    .get(sinceSec) as { tokens: number; sessions: number; events: number };

  return {
    accounts: rows.length,
    totals: { ...totals, tokens: Number(totals.tokens), active_accounts: rows.filter((r) => r.events > 0).length },
    entries: rows.map(({ id, display_name, avatar_url, ...r }) => ({
      ...r,
      avatar_url,
      tokens: Number(r.tokens),
      username: r.username ?? "",
      display_name: display_name || r.username || "",
      top_model: topModels.get(id) ?? null,
      current_streak: streak(daysByUser.get(id)),
    })),
    by_model: db
      .prepare(
        `SELECT COALESCE(e.model, 'unknown') AS name, SUM(${TOKENS}) AS tokens,
                COUNT(DISTINCT e.session_id) AS sessions, COUNT(*) AS events
         FROM ${LISTED} AND e.occurred_at >= ?
         GROUP BY name ORDER BY tokens DESC`
      )
      .all(sinceSec) as BreakdownRow[],
    activity: db
      .prepare(
        `SELECT date(e.occurred_at, 'unixepoch') AS day, SUM(${TOKENS}) AS tokens,
                COUNT(DISTINCT e.session_id) AS sessions
         FROM ${LISTED} AND e.occurred_at >= ?
         GROUP BY day ORDER BY day`
      )
      .all(activitySinceSec) as ActivityDay[],
  };
}
