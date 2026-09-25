import { createHash, randomUUID } from "node:crypto";
import type {
  Account, ActivityDay, AdminOverview, AdminUser, Profile, Breakdown, BreakdownRow, Device, Quota, Session,
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
  password_hash: string | null;
  is_admin: number;
  disabled: number;
}

export function toAccount(u: UserRow): Account {
  return {
    id: u.id,
    username: u.username ?? "",
    display_name: u.display_name || u.username || "",
    is_admin: Boolean(u.is_admin),
  };
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
    .all() as UserRow[]).map((u) => ({ username: u.username ?? "", display_name: toAccount(u).display_name }));
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

/**
 * Insert an incremental usage event.
 *
 * Dedup strategy: the statusLine fires several times per user prompt (one
 * snapshot per API call in the agentic loop, plus unchanged re-fires on
 * compact / permission / vim events). Each DISTINCT usage snapshot is one
 * API call's consumption and must be kept; only an IDENTICAL snapshot for
 * the same device+prompt is a duplicate trigger and is dropped. Dropping
 * every snapshot after the first per prompt would undercount ~3x.
 */
export function insertUsageEvent(db: DB, ev: UsageEventInput): { inserted: boolean; deduped: boolean } {
  // Natural dedup: identical snapshot already stored for this device+prompt.
  if (ev.prompt_id) {
    const existing = db
      .prepare(
        `SELECT event_id FROM usage_events
         WHERE device_id = ? AND prompt_id = ?
           AND input_tokens = ? AND output_tokens = ?
           AND cache_read_tokens = ? AND cache_write_tokens = ?
           AND COALESCE(model, '') = COALESCE(?, '')
         LIMIT 1`
      )
      .get(
        ev.device_id, ev.prompt_id,
        ev.input_tokens, ev.output_tokens, ev.cache_read_tokens, ev.cache_write_tokens,
        ev.model
      );
    if (existing) return { inserted: false, deduped: true };
  }
  try {
    db.prepare(
      `INSERT INTO usage_events
        (event_id, device_id, user_id, tool, session_id, prompt_id, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         context_window_size, context_used_pct, occurred_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      ev.event_id, ev.device_id, ev.user_id, ev.tool, ev.session_id, ev.prompt_id, ev.model,
      ev.input_tokens, ev.output_tokens, ev.cache_read_tokens, ev.cache_write_tokens,
      ev.context_window_size, ev.context_used_pct, ev.occurred_at, ev.received_at
    );
    return { inserted: true, deduped: false };
  } catch (err) {
    if (String((err as { code?: string })?.code) === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      return { inserted: false, deduped: true };
    }
    throw err;
  }
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
