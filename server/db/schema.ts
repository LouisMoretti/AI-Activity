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
  `);

  // Databases from before the cost feature was removed may still hold
  // usage_events.cost_estimated_usd and the billing_records / subscriptions
  // tables: they are left as is and never read or written.

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
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_by INTEGER REFERENCES users(id),
      used_at INTEGER,
      revoked INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Ensure at least one user exists: before any account is set up, every
  // device (keys from gen-key) maps to user 1, which the first account claims.
  const row = db.prepare("SELECT id FROM users ORDER BY id LIMIT 1").get();
  if (!row) {
    db.prepare("INSERT INTO users (created_at) VALUES (?)").run(nowSec());
  }
}
