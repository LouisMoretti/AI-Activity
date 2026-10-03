import type { DB } from "./schema.ts";

/**
 * Schema migrations, in order. Migration N brings a database from
 * `user_version` N - 1 to N; `migrate()` in schema.ts runs each pending one
 * in its own transaction and bumps the version with it.
 *
 * To change the schema, append a new function: never edit or reorder one
 * that has shipped, since existing databases already ran it. A new step runs
 * exactly once per database, so it needs no "already done?" guard.
 */
export const MIGRATIONS: ((db: DB) => void)[] = [
  baseline,
  cleanupCoveredSnapshots,
  activityClearedAt,
  collectorVersions,
  githubAccounts,
  apiValueInputs,
  siteAnalytics,
  profilePanels,
];

/**
 * 8: each account's dashboard layout, `users.panels`: JSON rows of panels
 * (`validLayout` in queries.ts). NULL, the value of every account until it
 * saves another layout, means the default layout of the code that runs
 * (`DEFAULT_ROWS`), so a new default or a new tool reaches those accounts.
 */
function profilePanels(db: DB): void {
  db.exec("ALTER TABLE users ADD COLUMN panels TEXT");
}

/**
 * 7: privacy-first site analytics, kept apart from measured AI activity:
 * daily page views by page category and source, visitors and sign-ups.
 * A visitor is an HMAC that changes every day (rows of different days cannot
 * be linked), marked new or returning (NULL: the browser sent no id) from
 * `site_analytics_known_visitors`: its random id's HMAC with the first and
 * last day seen, nothing in between. External reads of the public API
 * (by route, origin host and client kind; distinct clients per day); and
 * requests refused with 429 (by scope, a fixed set; distinct clients).
 */
function siteAnalytics(db: DB): void {
  db.exec(`
    CREATE TABLE site_analytics_pageviews (
      day TEXT NOT NULL,
      page TEXT NOT NULL,
      source TEXT NOT NULL,
      views INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, page, source)
    ) WITHOUT ROWID;
    CREATE TABLE site_analytics_visitors (
      day TEXT NOT NULL,
      visitor_hash TEXT NOT NULL,
      returning_visitor INTEGER,
      PRIMARY KEY (day, visitor_hash)
    ) WITHOUT ROWID;
    CREATE TABLE site_analytics_signups (
      day TEXT PRIMARY KEY,
      signups INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
    CREATE TABLE site_analytics_known_visitors (
      visitor_hash TEXT PRIMARY KEY,
      first_day TEXT NOT NULL,
      last_day TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX idx_site_analytics_known_last ON site_analytics_known_visitors(last_day);
    CREATE TABLE site_analytics_api_calls (
      day TEXT NOT NULL,
      route TEXT NOT NULL,
      origin TEXT NOT NULL,
      client TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, route, origin, client)
    ) WITHOUT ROWID;
    CREATE TABLE site_analytics_api_clients (
      day TEXT NOT NULL,
      client_hash TEXT NOT NULL,
      PRIMARY KEY (day, client_hash)
    ) WITHOUT ROWID;
    CREATE TABLE site_analytics_rate_limited (
      day TEXT NOT NULL,
      scope TEXT NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, scope)
    ) WITHOUT ROWID;
    CREATE TABLE site_analytics_rate_limited_clients (
      day TEXT NOT NULL,
      client_hash TEXT NOT NULL,
      PRIMARY KEY (day, client_hash)
    ) WITHOUT ROWID;
  `);
}

/**
 * 6: what an API-equivalent value needs besides model and token counts
 * (issue #113, shared/pricing.ts). `cache_write_1h_tokens`: of the cache
 * writes, those to Anthropic's 1-hour cache (2× input instead of 1.25×;
 * NULL: not recorded, priced at the 5-minute rate as a lower bound).
 * `service_tier`: the processing tier as the tool recorded it (Claude Code's
 * fast mode as "fast", Codex's service tier); NULL: standard.
 * `inference_geo`: Anthropic's inference region ("us" costs 1.1×). The read
 * index covers them, so pricing reads stay index-only.
 */
function apiValueInputs(db: DB): void {
  db.exec(`
    ALTER TABLE usage_events ADD COLUMN cache_write_1h_tokens INTEGER;
    ALTER TABLE usage_events ADD COLUMN service_tier TEXT;
    ALTER TABLE usage_events ADD COLUMN inference_geo TEXT;
    DROP INDEX IF EXISTS idx_usage_user_read;
    CREATE INDEX idx_usage_user_read ON usage_events(
      user_id, occurred_at, tool, session_id, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, utc_offset_min,
      cache_write_1h_tokens, service_tier, inference_geo
    );
  `);
}

/**
 * 5: sign in with GitHub only (issue #127). `users.github_id` is the GitHub
 * account's numeric id (stable across login renames). Accounts from before
 * could never sign in again, so the database starts over: every account,
 * its usage, quotas, devices and sessions go (the `-pre-v<N>` backup made
 * before the upgrade that ran it keeps them). People sign in with GitHub, make a device key in Settings, and
 * the collectors send their whole local history again (their offsets are
 * kept per server and key).
 */
function githubAccounts(db: DB): void {
  db.exec(`
    DELETE FROM collector_versions;
    DELETE FROM deleted_events;
    DELETE FROM usage_events;
    DELETE FROM quota_snapshots;
    DELETE FROM devices;
    DELETE FROM viewer_sessions;
    DELETE FROM settings;
    -- Empty, so rebuilt strict: every account has a GitHub id and a
    -- username (no pre-accounts placeholder, no password). The other
    -- tables' foreign keys name "users" and follow the new table.
    DROP TABLE users;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      github_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0,
      activity_cleared_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_users_github ON users(github_id);
    CREATE UNIQUE INDEX idx_users_username ON users(username COLLATE NOCASE);
    DELETE FROM sqlite_sequence; -- ids start at 1 again: the first account is #1
  `);
}

/**
 * 3: deleting your own activity. `users.activity_cleared_at` is when the
 * user last did (unix seconds, NULL if never): ingest drops usage, quotas
 * and context dated up to then. `deleted_events` keeps the ids of the
 * deleted messages (ids only, no counts), so a resend is refused whatever
 * time a skewed device clock puts on it.
 */
function activityClearedAt(db: DB): void {
  db.exec(`
    ALTER TABLE users ADD COLUMN activity_cleared_at INTEGER;
    CREATE TABLE deleted_events (
      user_id INTEGER NOT NULL REFERENCES users(id),
      event_id TEXT NOT NULL,
      PRIMARY KEY (user_id, event_id)
    ) WITHOUT ROWID;
  `);
}

/**
 * 4: The collector versions each device posted with, per tool, and when
 * each last did (issue #125), so Settings → Devices can flag outdated
 * copies, including an old one still posting next to an updated one.
 * Deleting an account deletes its devices' rows first.
 */
function collectorVersions(db: DB): void {
  db.exec(`
    CREATE TABLE collector_versions (
      device_id INTEGER NOT NULL REFERENCES devices(id),
      tool TEXT NOT NULL,
      version INTEGER NOT NULL,
      seen_at INTEGER NOT NULL,
      PRIMARY KEY (device_id, tool, version)
    ) WITHOUT ROWID
  `);
}

/**
 * 2: Apply the message-ingestion snapshot cleanup retroactively. The first
 * version of that cleanup did not include the two-minute statusLine slack;
 * collectors that had already advanced their offsets did not resend those
 * old messages after the fix, leaving a snapshot one or two seconds before
 * the first message to be counted alongside the exact transcript rows.
 *
 * Same rule as dropSnapshotRows (user + session, no tool), measured from the
 * session's oldest stored message. The 120 s is SNAPSHOT_SLACK_SEC as of this
 * migration, frozen on purpose. Each session's first message is computed once
 * (a correlated subquery per snapshot row is quadratic and blocks startup).
 */
function cleanupCoveredSnapshots(db: DB): void {
  db.exec(`
    DELETE FROM usage_events WHERE rowid IN (
      SELECT snapshot.rowid
      FROM usage_events AS snapshot
      JOIN (
        SELECT user_id, session_id, MIN(occurred_at) AS first_at
        FROM usage_events
        WHERE source = 'message'
        GROUP BY user_id, session_id
      ) AS message USING (user_id, session_id)
      WHERE snapshot.source = 'snapshot'
        AND snapshot.occurred_at >= message.first_at - 120
    )
  `);
}

/**
 * 1: the schema as it was before versioned migrations. Every database made
 * until then is at version 0 with any subset of these changes applied, so
 * this step alone keeps its checks: it must bring any of them (and an empty
 * file) to the same schema.
 */
function baseline(db: DB): void {
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
  const cols = columns(db, "usage_events");
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
  if (!columns(db, "devices").has("key")) db.exec("ALTER TABLE devices ADD COLUMN key TEXT");

  // Accounts: the pre-accounts single user (id 1) keeps all its data and
  // gets a username once the first account is set up.
  const userCols = columns(db, "users");
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
    db.prepare("INSERT INTO users (created_at) VALUES (?)").run(Math.floor(Date.now() / 1000));
  }
}

function columns(db: DB, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}
