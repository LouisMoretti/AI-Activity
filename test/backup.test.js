import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openDb } from "../server/db/schema.ts";
import { backupTo, pruneBackups } from "../server/lib/backup.ts";
import { startServer, req, newDevice, event } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V0_FIXTURE = fs.readFileSync(new URL("./fixtures/schema-v0.sql", import.meta.url), "utf8");

/** Runs scripts/<name>.ts against a database, like npm run <name>. */
function script(name, dbPath, args = [], env = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "scripts", `${name}.ts`), ...args], {
      env: { ...process.env, DB_PATH: dbPath, ...env },
    });
    let out = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (out += c));
    proc.on("exit", (code) => resolve({ code, out }));
  });
}

const backupsIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const eventIds = (file) => {
  const db = new Database(file, { readonly: true });
  try {
    return new Set(db.prepare("SELECT event_id FROM usage_events").pluck().all());
  } finally {
    db.close();
  }
};

describe("backups", () => {
  test("a backup taken while events are posted opens, passes integrity_check and holds every event accepted before it", async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());
    const { key } = await newDevice(srv.base);
    const accepted = [];
    let writing = true;
    const writer = (async () => {
      while (writing) {
        const batch = Array.from({ length: 20 }, () => event());
        const r = await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: { messages: batch.map((e) => ({ ...e, message_id: e.event_id })) } });
        assert.equal(r.status, 200);
        accepted.push(...batch.map((e) => e.event_id));
      }
    })();
    while (accepted.length < 200) await new Promise((r) => setTimeout(r, 10));
    const before = [...accepted];
    const dir = path.join(path.dirname(srv.dbPath), "backups");
    const run = await script("backup", srv.dbPath);
    writing = false;
    await writer;
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /integrity ok/);
    const [file] = backupsIn(dir);
    assert.match(file, /^t-\d{8}-\d{6}\.db$/);
    assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600);
    const inBackup = eventIds(path.join(dir, file));
    for (const id of before) assert.ok(inBackup.has(id), `${id} missing from the backup`);
    // No -wal next to it: one self-contained file.
    assert.deepEqual(backupsIn(dir), [file]);
  });

  test("--out picks the directory; a missing database fails without writing anything", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-backup-"));
    try {
      const out = path.join(dir, "elsewhere");
      const missing = await script("backup", path.join(dir, "nope.db"), ["--out", out]);
      assert.notEqual(missing.code, 0);
      assert.match(missing.out, /Backup failed/);
      assert.ok(!fs.existsSync(path.join(dir, "nope.db")));
      openDb(path.join(dir, "d.db")).close();
      const ok = await script("backup", path.join(dir, "d.db"), ["--out", out]);
      assert.equal(ok.code, 0, ok.out);
      assert.equal(backupsIn(out).length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retention keeps the newest backup of the last 7 days and 4 weeks, and nothing else is touched", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-prune-"));
    try {
      const names = [];
      // Two backups a day for 40 days, ending Friday 2026-09-25.
      for (let i = 0; i < 40; i++) {
        const d = new Date(Date.UTC(2026, 8, 25 - i)).toISOString().slice(0, 10).replace(/-/g, "");
        names.push(`dashboard-${d}-020000.db`, `dashboard-${d}-140000.db`);
      }
      const others = ["dashboard-20260801-020000-pre-v2.db", "dashboard-20260925-140001-pre-restore.db", "other-20260801-020000.db", "notes.txt"];
      for (const n of [...names, ...others]) fs.writeFileSync(path.join(dir, n), "");
      const removed = pruneBackups(dir, "/data/dashboard.db");
      const kept = backupsIn(dir).filter((n) => !others.includes(n));
      assert.deepEqual(kept, [
        // newest of weeks 36, 37 and 38 (Sundays 09-06, 09-13, 09-20; week 39 is covered by the daily ones)
        "dashboard-20260906-140000.db",
        "dashboard-20260913-140000.db",
        "dashboard-20260919-140000.db",
        "dashboard-20260920-140000.db",
        "dashboard-20260921-140000.db",
        "dashboard-20260922-140000.db",
        "dashboard-20260923-140000.db",
        "dashboard-20260924-140000.db",
        "dashboard-20260925-140000.db",
      ]);
      assert.equal(removed.length, names.length - kept.length);
      for (const n of others) assert.ok(fs.existsSync(path.join(dir, n)), `${n} was deleted`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restore: back up, wipe the data, restore, start → same totals; refused while the server runs", async (t) => {
    const srv = await startServer();
    const { key } = await newDevice(srv.base);
    for (let i = 0; i < 3; i++) {
      assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ session_id: `s${i}` }) })).status, 200);
    }
    const summary = async (base) => (await req(base, "GET", "/api/u/admin/summary", { anon: true })).json.total;
    const expected = await summary(srv.base);
    assert.equal(expected.sessions, 3);

    assert.equal((await script("backup", srv.dbPath)).code, 0);
    const dir = path.join(path.dirname(srv.dbPath), "backups");
    const [file] = backupsIn(dir);

    const busy = await script("restore", srv.dbPath, [path.join(dir, file)]);
    assert.notEqual(busy.code, 0);
    assert.match(busy.out, /in use: stop the server/);

    await srv.kill();
    for (const ext of ["", "-wal", "-shm"]) fs.rmSync(srv.dbPath + ext, { force: true });
    const restore = await script("restore", srv.dbPath, [path.join(dir, file)]);
    assert.equal(restore.code, 0, restore.out);

    const again = await startServer({ env: { DB_PATH: srv.dbPath }, autoLogin: false });
    t.after(async () => {
      await again.kill();
      await srv.stop();
    });
    assert.deepEqual(await summary(again.base), expected);
  });

  test("restoring over a database keeps a copy of it first; a backup that is not a database is refused", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-restore-"));
    try {
      const dbPath = path.join(dir, "dashboard.db");
      openDb(dbPath).close();
      assert.equal((await script("backup", dbPath)).code, 0);
      const [file] = backupsIn(path.join(dir, "backups"));
      const garbage = path.join(dir, "garbage.db");
      fs.writeFileSync(garbage, "not a database");
      const bad = await script("restore", dbPath, [garbage]);
      assert.notEqual(bad.code, 0);
      const ok = await script("restore", dbPath, [path.join(dir, "backups", file)]);
      assert.equal(ok.code, 0, ok.out);
      assert.ok(backupsIn(path.join(dir, "backups")).some((n) => n.endsWith("-pre-restore.db")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("backups in the same second get distinct names; the directory is made private even if it existed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-samesec-"));
    try {
      const out = path.join(dir, "backups");
      fs.mkdirSync(out, { mode: 0o755 });
      fs.chmodSync(out, 0o755);
      const db = openDb(path.join(dir, "dashboard.db"));
      const now = new Date("2026-09-25T13:40:52Z");
      try {
        const a = backupTo(db, out, { now });
        const b = backupTo(db, out, { now });
        const c = backupTo(db, out, { now, suffix: "-pre-v2" });
        assert.equal(path.basename(a.file), "dashboard-20260925-134052.db");
        assert.equal(path.basename(b.file), "dashboard-20260925-134052-2.db");
        assert.equal(path.basename(c.file), "dashboard-20260925-134052-pre-v2.db");
      } finally {
        db.close();
      }
      assert.equal(fs.statSync(out).mode & 0o777, 0o700);
      for (const f of fs.readdirSync(out)) assert.equal(fs.statSync(path.join(out, f)).mode & 0o777, 0o600, f);
      // The -2 copy is a rotated backup too; the pre-upgrade one never is.
      pruneBackups(out, path.join(dir, "dashboard.db"), { daily: 1, weekly: 0 });
      assert.deepEqual(backupsIn(out).length, 2);
      assert.ok(backupsIn(out).includes("dashboard-20260925-134052-pre-v2.db"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restoring over a corrupt database sets it aside instead of failing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-corrupt-"));
    try {
      const dbPath = path.join(dir, "dashboard.db");
      openDb(dbPath).close();
      assert.equal((await script("backup", dbPath)).code, 0);
      const [file] = backupsIn(path.join(dir, "backups"));
      fs.writeFileSync(dbPath, "this is not a database anymore");
      const r = await script("restore", dbPath, [path.join(dir, "backups", file)]);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /could not be read/);
      assert.ok(fs.readdirSync(dir).some((n) => n.startsWith("dashboard.db.corrupt-")));
      const db = new Database(dbPath, { readonly: true });
      assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an existing database is backed up before its schema is upgraded; a new one is not", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-premigrate-"));
    try {
      const old = path.join(dir, "old.db");
      const seed = new Database(old);
      seed.exec(V0_FIXTURE);
      seed.close();
      openDb(old).close();
      const [file] = backupsIn(path.join(dir, "backups"));
      assert.match(file, /^old-\d{8}-\d{6}-pre-v\d+\.db$/);
      const copy = new Database(path.join(dir, "backups", file), { readonly: true });
      assert.equal(copy.pragma("user_version", { simple: true }), 0);
      assert.ok(copy.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n > 0);
      copy.close();
      // Already up to date: no second copy.
      openDb(old).close();
      assert.equal(backupsIn(path.join(dir, "backups")).length, 1);

      const fresh = path.join(dir, "fresh", "new.db");
      openDb(fresh).close();
      assert.deepEqual(backupsIn(path.join(dir, "fresh", "backups")), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
