import { createHash, randomUUID } from "node:crypto";
import type {
  ActivityDay, BillingRecord, Breakdown, BreakdownRow, Device, Quota, Session, Subscription,
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
  cost_estimated_usd: number | null;
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
  estimated_usd: number;
  events: number;
  sessions: number;
}

export function hashKey(rawKey: string): string {
  return createHash("sha256").update(String(rawKey)).digest("hex");
}

export function getDefaultUserId(db: DB): number {
  return (db.prepare("SELECT id FROM users ORDER BY id LIMIT 1").get() as { id: number }).id;
}

export function findDeviceByKey(db: DB, rawKey: string | null): DeviceRow | null {
  if (!rawKey) return null;
  const row = db
    .prepare("SELECT * FROM devices WHERE key_hash = ?")
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

export function revokeDevice(db: DB, id: number): void {
  db.prepare("UPDATE devices SET revoked = 1 WHERE id = ?").run(id);
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
         cost_estimated_usd, context_window_size, context_used_pct, occurred_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      ev.event_id, ev.device_id, ev.user_id, ev.tool, ev.session_id, ev.prompt_id, ev.model,
      ev.input_tokens, ev.output_tokens, ev.cache_read_tokens, ev.cache_write_tokens,
      ev.cost_estimated_usd, ev.context_window_size, ev.context_used_pct, ev.occurred_at, ev.received_at
    );
    return { inserted: true, deduped: false };
  } catch (err) {
    if (String((err as { code?: string })?.code) === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      return { inserted: false, deduped: true };
    }
    throw err;
  }
}

export function insertQuotaSnapshot(db: DB, q: QuotaSnapshotInput): void {
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
         COALESCE(SUM(cost_estimated_usd), 0) AS estimated_usd,
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
 * Most recent sessions. Context fill comes from the session's latest event
 * that reported it (a gauge at that moment, never summed).
 */
export function recentSessions(db: DB, userId: number, limit: number, tool: string | null): Session[] {
  return db
    .prepare(
      `SELECT s.*, c.context_used_pct, c.context_window_size FROM (
         SELECT session_id, tool, MAX(model) AS model,
                SUM(${TOKENS}) AS tokens,
                MAX(occurred_at) AS last_seen, COUNT(*) AS events
         FROM usage_events
         WHERE user_id = ? AND session_id IS NOT NULL AND (? IS NULL OR tool = ?)
         GROUP BY session_id, tool
         ORDER BY last_seen DESC LIMIT ?
       ) s
       LEFT JOIN (
         SELECT session_id, tool, context_used_pct, context_window_size,
                ROW_NUMBER() OVER (
                  PARTITION BY session_id, tool ORDER BY occurred_at DESC, received_at DESC
                ) AS rn
         FROM usage_events
         WHERE user_id = ? AND context_used_pct IS NOT NULL
       ) c ON c.session_id = s.session_id AND c.tool = s.tool AND c.rn = 1
       ORDER BY s.last_seen DESC`
    )
    .all(userId, tool, tool, limit, userId) as Session[];
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

export function estimatedCostAvailable(db: DB, userId: number): boolean {
  return Boolean(db
    .prepare("SELECT 1 FROM usage_events WHERE user_id = ? AND cost_estimated_usd IS NOT NULL LIMIT 1")
    .get(userId));
}

export function listSubscriptions(db: DB, userId: number): Subscription[] {
  return db
    .prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as Subscription[];
}

export function listBillingRecords(db: DB, userId: number): BillingRecord[] {
  return db
    .prepare("SELECT * FROM billing_records WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as BillingRecord[];
}

export function insertSubscription(
  db: DB,
  userId: number,
  s: Pick<Subscription, "tool" | "plan_name" | "amount" | "currency" | "period_start" | "period_end" | "note">
): number {
  const info = db
    .prepare(
      `INSERT INTO subscriptions
        (user_id, tool, plan_name, amount, currency, period_start, period_end, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, s.tool, s.plan_name, s.amount, s.currency, s.period_start, s.period_end, s.note, nowSec());
  return Number(info.lastInsertRowid);
}
