import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { openDb, schemaVersion } from "../server/db/schema.ts";
import { MIGRATIONS } from "../server/db/migrations.ts";
import { startServer } from "./helpers.js";

const LATEST = MIGRATIONS.length;
const V0_FIXTURE = fs.readFileSync(new URL("./fixtures/schema-v0.sql", import.meta.url), "utf8");

// The oldest layout still worth upgrading: before accounts, local days and
// per-message ingestion, with the leftovers of removed features.
const LEGACY = `
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL);
  CREATE TABLE devices (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL DEFAULT '', revoked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL);
  CREATE TABLE usage_events (event_id TEXT PRIMARY KEY, device_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    tool TEXT NOT NULL, session_id TEXT, prompt_id TEXT, model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_estimated_usd REAL, occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL);
  CREATE INDEX idx_usage_user_time ON usage_events(user_id, occurred_at);
  CREATE INDEX idx_usage_user_read ON usage_events(user_id, occurred_at, tool);
  CREATE TABLE billing_records (id INTEGER PRIMARY KEY);
  CREATE TABLE app_settings (key TEXT PRIMARY KEY);
  INSERT INTO users (id, created_at) VALUES (1, 0);
  INSERT INTO devices (user_id, name, key_hash, created_at) VALUES (1, 'old', 'h', 0);
  INSERT INTO usage_events (event_id, device_id, user_id, tool, input_tokens, cost_estimated_usd, occurred_at, received_at)
    VALUES ('e1', 1, 1, 'claude-code', 42, 0.1, 0, 0);
`;

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-migrate-"));
  return { dir, file: path.join(dir, "t.db") };
}

/** A database file made with raw SQL, as an older server left it. */
function seeded(sql, version = 0) {
  const t = tmpDb();
  const db = new Database(t.file);
  db.exec(sql);
  db.pragma(`user_version = ${version}`);
  db.close();
  return t;
}

/**
 * The schema as SQLite sees it, independent of how it was reached: columns
 * by name (ALTER TABLE appends, so their order depends on history), indexes
 * by definition.
 */
function schema(db) {
  const objects = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all();
  return objects.map((o) =>
    o.type === "table"
      ? {
          table: o.name,
          columns: db
            .prepare(`PRAGMA table_info(${o.name})`)
            .all()
            .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }
      : { index: o.name, on: o.tbl_name, sql: o.sql?.replace(/\s+/g, " ") }
  );
}

function freshSchema() {
  const t = tmpDb();
  const db = openDb(t.file);
  try {
    return schema(db);
  } finally {
    db.close();
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
}

describe("versioned migrations", () => {
  test("a new database runs every migration and ends at the latest version", () => {
    const t = tmpDb();
    const db = openDb(t.file);
    try {
      assert.equal(schemaVersion(db), LATEST);
      // The first account's placeholder user exists before any account.
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 1);
    } finally {
      db.close();
      fs.rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("a version 0 database (the last unversioned schema) upgrades to the fresh schema, data kept", () => {
    const t = seeded(V0_FIXTURE);
    const db = openDb(t.file);
    try {
      assert.equal(schemaVersion(db), LATEST);
      assert.deepEqual(schema(db), freshSchema());
      assert.deepEqual(
        db.prepare("SELECT id, username, is_admin, disabled FROM users ORDER BY id").all().map((r) => ({ ...r })),
        [
          { id: 1, username: "louis", is_admin: 1, disabled: 0 },
          { id: 2, username: "alice", is_admin: 0, disabled: 1 },
        ]
      );
      assert.equal(db.prepare("SELECT key FROM devices WHERE id = 1").get().key, "aiu_abcdsecret");
      const e = db.prepare("SELECT * FROM usage_events WHERE event_id = 'msg_1'").get();
      assert.equal(e.cache_write_tokens, 40);
      assert.equal(e.source, "message");
      assert.equal(e.utc_offset_min, 120);
      assert.equal(e.context_used_pct, 42.5);
      assert.equal(db.prepare("SELECT source FROM usage_events WHERE event_id = 'snap_1'").get().source, "snapshot");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM quota_snapshots").get().n, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM viewer_sessions").get().n, 1);
      assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'signup_open'").get().value, "0");
    } finally {
      db.close();
      fs.rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("an older unversioned layout upgrades to the fresh schema too", () => {
    const t = seeded(LEGACY);
    const db = openDb(t.file);
    try {
      assert.equal(schemaVersion(db), LATEST);
      assert.deepEqual(schema(db), freshSchema());
      const e = db.prepare("SELECT input_tokens, source, utc_offset_min FROM usage_events WHERE event_id = 'e1'").get();
      assert.deepEqual({ ...e }, { input_tokens: 42, source: "snapshot", utc_offset_min: null });
    } finally {
      db.close();
      fs.rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("reopening an up-to-date database changes nothing", () => {
    const t = tmpDb();
    openDb(t.file).close();
    const before = new Database(t.file, { readonly: true });
    const snapshot = schema(before);
    const users = before.prepare("SELECT COUNT(*) AS n FROM users").get().n;
    before.close();
    const db = openDb(t.file);
    try {
      assert.equal(schemaVersion(db), LATEST);
      assert.deepEqual(schema(db), snapshot);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n, users);
    } finally {
      db.close();
      fs.rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("a failing migration rolls back entirely and leaves the version as it was", () => {
    const t = tmpDb();
    openDb(t.file).close();
    MIGRATIONS.push((db) => {
      db.exec("CREATE TABLE half_done (a INTEGER)");
      throw new Error("boom");
    });
    try {
      assert.throws(() => openDb(t.file), /boom/);
    } finally {
      MIGRATIONS.pop();
    }
    const db = new Database(t.file, { readonly: true });
    try {
      assert.equal(db.pragma("user_version", { simple: true }), LATEST);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half_done'").get().n, 0);
    } finally {
      db.close();
      fs.rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("a database from a newer version is refused and left untouched", async () => {
    const t = tmpDb();
    openDb(t.file).close();
    const newer = new Database(t.file);
    newer.pragma(`user_version = ${LATEST + 1}`);
    newer.close();
    try {
      assert.throws(() => openDb(t.file), /newer than this server knows/);
      await assert.rejects(startServer({ env: { DB_PATH: t.file }, autoLogin: false }), /newer than this server knows/);
      const db = new Database(t.file, { readonly: true });
      assert.equal(db.pragma("user_version", { simple: true }), LATEST + 1);
      db.close();
    } finally {
      fs.rmSync(t.dir, { recursive: true, force: true });
    }
  });
});
