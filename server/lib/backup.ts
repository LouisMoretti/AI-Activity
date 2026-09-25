import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db/schema.ts";

// Backups are named after the database file and dated in UTC:
// dashboard.db → dashboard-20260925-134052.db. Only names of that exact
// shape are rotated; pre-upgrade copies (dashboard-…-pre-v2.db) and anything
// else in the directory are never deleted.
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const stem = (dbPath: string) => path.basename(dbPath).replace(/\.[^.]*$/, "");

export interface BackupResult {
  file: string;
  bytes: number;
  events: number;
  version: number;
}

/**
 * A consistent snapshot of a live database: VACUUM INTO reads it in one
 * transaction (the WAL included), so writers keep going and the copy holds
 * everything committed before it started. It is written under a temporary
 * name and only renamed once it passes an integrity check, so a crash or a
 * full disk never leaves a half-written backup that looks complete.
 * Backups hold password, session and device key hashes (and copyable device
 * keys): the directory is private to the server's user.
 */
export function backupTo(db: DB, dir: string, { now = new Date(), suffix = "" } = {}): BackupResult {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${stem(db.name)}-${stamp(now)}${suffix}.db`);
  if (fs.existsSync(file)) throw new Error(`${file} already exists`);
  const partial = `${file}.partial`;
  fs.rmSync(partial, { force: true });
  try {
    db.prepare("VACUUM INTO ?").run(partial);
    fs.chmodSync(partial, 0o600);
    const info = checkBackup(partial);
    fs.renameSync(partial, file);
    return { file, bytes: fs.statSync(file).size, ...info };
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }
}

/** Opens a backup read-only: it must pass integrity_check and hold the schema. */
export function checkBackup(file: string): { events: number; version: number } {
  const copy = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const check = copy.pragma("integrity_check", { simple: true });
    if (check !== "ok") throw new Error(`${file} failed integrity_check: ${check}`);
    const { n } = copy.prepare("SELECT COUNT(*) AS n FROM usage_events").get() as { n: number };
    return { events: n, version: copy.pragma("user_version", { simple: true }) as number };
  } finally {
    copy.close();
  }
}

/**
 * Keeps the newest backup of each of the last `daily` days that have one,
 * and of each of the last `weekly` ISO weeks; deletes the other rotated
 * backups of this database. Returns the deleted files.
 */
export function pruneBackups(dir: string, dbPath: string, { daily = 7, weekly = 4 } = {}): string[] {
  const re = new RegExp(`^${stem(dbPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d{8})-(\\d{6})\\.db$`);
  const backups = fs
    .readdirSync(dir)
    .map((name) => ({ name, m: name.match(re) }))
    .filter((b) => b.m)
    .map(({ name, m }) => ({ name, day: m![1], week: isoWeek(m![1]) }))
    .sort((a, b) => b.name.localeCompare(a.name)); // newest first: the stamp sorts
  const keep = new Set<string>();
  const newestPer = (key: "day" | "week", count: number) => {
    const seen = new Set<string>();
    for (const b of backups) {
      if (seen.has(b[key])) continue;
      if (seen.size >= count) break;
      seen.add(b[key]);
      keep.add(b.name);
    }
  };
  newestPer("day", Math.max(1, daily));
  newestPer("week", weekly);
  const removed = backups.filter((b) => !keep.has(b.name)).map((b) => path.join(dir, b.name));
  for (const f of removed) fs.rmSync(f);
  return removed;
}

/** "20260925" → "2026-W39" (ISO 8601 week, Monday first). */
function isoWeek(day: string): string {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8)));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow); // the Thursday of that week names its year
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - jan1) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Replaces the database file with a backup. Refuses while anything else has
 * the database open: leaving WAL mode needs every other connection gone, so
 * a running server (or CLI) makes it fail instead of being swapped under.
 * The current database is backed up first (…-pre-restore.db).
 */
export function restoreFrom(backup: string, dbPath: string, backupDir: string, latestVersion: number): BackupResult | null {
  const { version } = checkBackup(backup);
  if (version > latestVersion) {
    throw new Error(`${backup} is at schema version ${version}, newer than this server knows (${latestVersion})`);
  }
  let saved: BackupResult | null = null;
  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath, { fileMustExist: true, timeout: 0 });
    try {
      try {
        db.pragma("journal_mode = DELETE");
      } catch {
        throw new Error(`${dbPath} is in use: stop the server (and any npm run user / gen-key) first`);
      }
      if (db.pragma("journal_mode", { simple: true }) !== "delete") {
        throw new Error(`${dbPath} is in use: stop the server (and any npm run user / gen-key) first`);
      }
      saved = backupTo(db, backupDir, { suffix: "-pre-restore" });
    } finally {
      db.close();
    }
  }
  const tmp = `${dbPath}.restoring`;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.copyFileSync(backup, tmp);
  fs.chmodSync(tmp, 0o600);
  // Stale WAL files belong to the old database: SQLite would replay them
  // onto the restored one.
  for (const ext of ["-wal", "-shm", "-journal"]) fs.rmSync(dbPath + ext, { force: true });
  fs.renameSync(tmp, dbPath);
  return saved;
}
