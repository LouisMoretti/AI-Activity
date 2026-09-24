import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function hashKey(rawKey) {
  return createHash("sha256").update(String(rawKey)).digest("hex");
}

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL DEFAULT '',
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      event_id TEXT PRIMARY KEY,
      device_id INTEGER NOT NULL REFERENCES devices(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      tool TEXT NOT NULL,
      session_id TEXT,
      prompt_id TEXT,
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_estimated_usd REAL,
      occurred_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_user_time
      ON usage_events(user_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_usage_device_prompt
      ON usage_events(device_id, prompt_id);
    CREATE INDEX IF NOT EXISTS idx_usage_session
      ON usage_events(session_id);

    CREATE TABLE IF NOT EXISTS quota_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL REFERENCES devices(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      account_ref TEXT NOT NULL DEFAULT 'default',
      tool TEXT NOT NULL DEFAULT 'claude-code',
      limit_type TEXT NOT NULL,
      used_pct REAL NOT NULL,
      resets_at INTEGER,
      measured_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quota_user_account
      ON quota_snapshots(user_id, account_ref, limit_type, measured_at);

    CREATE TABLE IF NOT EXISTS billing_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL,
      tool TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      period_start TEXT,
      period_end TEXT,
      source TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      tool TEXT NOT NULL,
      plan_name TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      period_start TEXT,
      period_end TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  // Ensure at least one default user exists (multi-user comes later;
  // every device maps to a user, currently user 1).
  const row = db.prepare("SELECT id FROM users ORDER BY id LIMIT 1").get();
  if (!row) {
    db.prepare("INSERT INTO users (created_at) VALUES (?)").run(nowSec());
  }
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function getDefaultUserId(db) {
  return db.prepare("SELECT id FROM users ORDER BY id LIMIT 1").get().id;
}

export function findDeviceByKey(db, rawKey) {
  if (!rawKey) return null;
  const row = db
    .prepare("SELECT * FROM devices WHERE key_hash = ?")
    .get(hashKey(rawKey));
  if (!row || row.revoked) return null;
  return row;
}

export function createDevice(db, { userId, name }) {
  const raw = `ak_${randomUUID().replace(/-/g, "")}`;
  const prefix = raw.slice(0, 10);
  const info = db
    .prepare(
      "INSERT INTO devices (user_id, name, key_hash, key_prefix, revoked, created_at) VALUES (?, ?, ?, ?, 0, ?)"
    )
    .run(userId, name || "unnamed device", hashKey(raw), prefix, nowSec());
  return { id: Number(info.lastInsertRowid), key: raw, prefix };
}

export function revokeDevice(db, id) {
  return db.prepare("UPDATE devices SET revoked = 1 WHERE id = ?").run(id);
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
 * Returns { inserted, deduped }.
 */
export function insertUsageEvent(db, ev) {
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
        ev.device_id,
        ev.prompt_id,
        ev.input_tokens ?? 0,
        ev.output_tokens ?? 0,
        ev.cache_read_tokens ?? 0,
        ev.cache_write_tokens ?? 0,
        ev.model ?? null
      );
    if (existing) return { inserted: false, deduped: true };
  }
  try {
    db.prepare(
      `INSERT INTO usage_events
        (event_id, device_id, user_id, tool, session_id, prompt_id, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cost_estimated_usd, occurred_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      ev.event_id,
      ev.device_id,
      ev.user_id,
      ev.tool,
      ev.session_id ?? null,
      ev.prompt_id ?? null,
      ev.model ?? null,
      ev.input_tokens ?? 0,
      ev.output_tokens ?? 0,
      ev.cache_read_tokens ?? 0,
      ev.cache_write_tokens ?? 0,
      ev.cost_estimated_usd ?? null,
      ev.occurred_at,
      ev.received_at
    );
    return { inserted: true, deduped: false };
  } catch (err) {
    if (String(err?.code) === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      return { inserted: false, deduped: true };
    }
    throw err;
  }
}

export function insertQuotaSnapshot(db, q) {
  db.prepare(
    `INSERT INTO quota_snapshots
      (device_id, user_id, account_ref, tool, limit_type, used_pct, resets_at, measured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    q.device_id,
    q.user_id,
    q.account_ref,
    q.tool,
    q.limit_type,
    q.used_pct,
    q.resets_at ?? null,
    q.measured_at
  );
}

/**
 * Latest snapshot per (account_ref, limit_type). Never summed across devices.
 * measured_at has 1 s resolution and the statusLine fires in bursts, so ties
 * are broken by insertion order (id) to always return exactly one row.
 */
export function latestQuotas(db, userId) {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT q.*, ROW_NUMBER() OVER (
           PARTITION BY account_ref, limit_type
           ORDER BY measured_at DESC, id DESC
         ) AS rn
         FROM quota_snapshots q WHERE user_id = ?
       ) WHERE rn = 1
       ORDER BY account_ref, limit_type`
    )
    .all(userId);
}

export function usageTotals(db, userId, sinceSec, tool) {
  const row = db
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
    .get(userId, sinceSec, tool ?? null, tool ?? null);
  return row;
}

export function dailyBuckets(db, userId, sinceSec, tool) {
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
    .all(userId, sinceSec, tool ?? null, tool ?? null);
}

export function recentSessions(db, userId, limit = 10) {
  return db
    .prepare(
      `SELECT session_id, tool, MAX(model) AS model,
              SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens,
              MAX(occurred_at) AS last_seen, COUNT(*) AS events
       FROM usage_events
       WHERE user_id = ? AND session_id IS NOT NULL
       GROUP BY session_id, tool
       ORDER BY last_seen DESC LIMIT ?`
    )
    .all(userId, limit);
}
