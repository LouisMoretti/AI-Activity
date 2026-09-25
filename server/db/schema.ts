import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type DB = Database.Database;

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function openDb(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
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
      occurred_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL
    );

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
  `);

  // Leftovers of removed features (cost tracking, invites, sign-up setting).
  db.exec(`
    DROP TABLE IF EXISTS billing_records;
    DROP TABLE IF EXISTS subscriptions;
    DROP TABLE IF EXISTS invites;
    DROP TABLE IF EXISTS app_settings;
  `);

  // Additive column migrations (SQLite has no ADD COLUMN IF NOT EXISTS).
  const cols = new Set(
    (db.prepare("PRAGMA table_info(usage_events)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!cols.has("context_window_size")) {
    db.exec("ALTER TABLE usage_events ADD COLUMN context_window_size INTEGER");
  }
  if (!cols.has("context_used_pct")) {
    db.exec("ALTER TABLE usage_events ADD COLUMN context_used_pct REAL");
  }
  // 'message': one row per Anthropic message id (transcript). 'snapshot':
  // older statusLine snapshots, which counted each API call about twice.
  if (!cols.has("source")) {
    db.exec("ALTER TABLE usage_events ADD COLUMN source TEXT NOT NULL DEFAULT 'snapshot'");
  }
  // The device's UTC offset when the event happened, in minutes: its day is
  // the local day there and then, like a GitHub contribution. NULL (older
  // collectors) counts as UTC.
  if (!cols.has("utc_offset_min")) {
    db.exec("ALTER TABLE usage_events ADD COLUMN utc_offset_min INTEGER");
  }
  if (cols.has("cost_estimated_usd")) {
    db.exec("ALTER TABLE usage_events DROP COLUMN cost_estimated_usd");
  }

  // Every read (stats, summary, activity, sessions, leaderboard) filters by
  // user and time and only needs these columns: the covering index lets
  // SQLite answer from the index alone instead of the table. The session
  // index groups the session list from the index; the per-session lookups
  // (latest model and context, snapshot cleanup) use it to find their rows
  // but read those columns from the table.
  // Indexes made before a column they now cover are rebuilt.
  for (const [name, col] of [["idx_usage_user_read", "utc_offset_min"], ["idx_usage_user_session_read", "utc_offset_min"]]) {
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) as { sql: string } | undefined;
    if (idx && !idx.sql.includes(col)) db.exec(`DROP INDEX ${name}`);
  }
  db.exec(`
    DROP INDEX IF EXISTS idx_usage_user_time;
    DROP INDEX IF EXISTS idx_usage_device_prompt;
    DROP INDEX IF EXISTS idx_usage_session;
    CREATE INDEX IF NOT EXISTS idx_usage_user_read ON usage_events(
      user_id, occurred_at, tool, session_id, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, utc_offset_min
    );
    CREATE INDEX IF NOT EXISTS idx_usage_user_session_read ON usage_events(
      user_id, session_id, tool, occurred_at,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, utc_offset_min
    );
  `);

  // Device keys are kept so their owner can copy them again from Settings
  // (ingest still looks them up by hash). Keys made before are hash only.
  const deviceCols = new Set(
    (db.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!deviceCols.has("key")) db.exec("ALTER TABLE devices ADD COLUMN key TEXT");

  // Accounts: the pre-accounts single user (id 1) keeps all its data and
  // gets a username once the first account is set up.
  const userCols = new Set(
    (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name)
  );
  for (const [col, type] of [
    ["username", "TEXT"],
    ["display_name", "TEXT"],
    ["password_hash", "TEXT"],
    ["is_admin", "INTEGER NOT NULL DEFAULT 0"],
    ["disabled", "INTEGER NOT NULL DEFAULT 0"],
    ["avatar_url", "TEXT"],
  ]) {
    if (!userCols.has(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
      ON users(username COLLATE NOCASE) WHERE username IS NOT NULL;
    CREATE TABLE IF NOT EXISTS viewer_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_viewer_sessions_user ON viewer_sessions(user_id);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Ensure at least one user exists: before any account is set up, every
  // device (keys from gen-key) maps to user 1, which the first account claims.
  const row = db.prepare("SELECT id FROM users ORDER BY id LIMIT 1").get();
  if (!row) {
    db.prepare("INSERT INTO users (created_at) VALUES (?)").run(nowSec());
  }
}
