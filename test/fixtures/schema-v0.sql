-- A database at user_version 0, as the server left it before versioned
-- migrations (#87): schema dumped from the old migrate(), plus some rows.
CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL
    , username TEXT, display_name TEXT, password_hash TEXT, is_admin INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, avatar_url TEXT);
CREATE TABLE devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL DEFAULT '',
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    , key TEXT);
CREATE TABLE usage_events (
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
    , context_window_size INTEGER, context_used_pct REAL, source TEXT NOT NULL DEFAULT 'snapshot', utc_offset_min INTEGER);
CREATE TABLE quota_snapshots (
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
CREATE INDEX idx_quota_user_account
      ON quota_snapshots(user_id, account_ref, limit_type, measured_at);
CREATE INDEX idx_usage_user_read ON usage_events(
      user_id, occurred_at, tool, session_id, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, utc_offset_min
    );
CREATE INDEX idx_usage_user_session_read ON usage_events(
      user_id, session_id, tool, occurred_at,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, utc_offset_min
    );
CREATE UNIQUE INDEX idx_users_username
      ON users(username COLLATE NOCASE) WHERE username IS NOT NULL;
CREATE TABLE viewer_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
CREATE INDEX idx_viewer_sessions_user ON viewer_sessions(user_id);
CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
INSERT INTO users (id, created_at, username, display_name, password_hash, is_admin) VALUES (1, 1750000000, 'louis', 'Louis', 'scrypt$x', 1);
INSERT INTO users (id, created_at, username, disabled) VALUES (2, 1750000100, 'alice', 1);
INSERT INTO devices (id, user_id, name, key_hash, key_prefix, created_at, key) VALUES (1, 1, 'laptop', 'hash1', 'aiu_abcd', 1750000000, 'aiu_abcdsecret');
INSERT INTO devices (id, user_id, name, key_hash, key_prefix, revoked, created_at) VALUES (2, 2, 'old', 'hash2', 'aiu_efgh', 1, 1750000100);
INSERT INTO usage_events (event_id, device_id, user_id, tool, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, occurred_at, received_at, context_window_size, context_used_pct, source, utc_offset_min)
  VALUES ('msg_1', 1, 1, 'claude-code', 's1', 'claude-opus-5-5', 10, 20, 30, 40, 1750000000, 1750000001, 200000, 42.5, 'message', 120);
INSERT INTO usage_events (event_id, device_id, user_id, tool, session_id, model, input_tokens, output_tokens, occurred_at, received_at)
  VALUES ('snap_1', 1, 1, 'claude-code', 's0', 'claude-opus-5', 5, 6, 1740000000, 1740000001);
INSERT INTO quota_snapshots (device_id, user_id, limit_type, used_pct, resets_at, measured_at) VALUES (1, 1, 'five_hour', 23.5, 1750018000, 1750000000);
INSERT INTO viewer_sessions (token_hash, user_id, expires_at, created_at) VALUES ('tok', 1, 1999999999, 1750000000);
INSERT INTO settings (key, value) VALUES ('signup_open', '0');
