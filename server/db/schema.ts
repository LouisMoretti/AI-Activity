import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./migrations.ts";

export type DB = Database.Database;

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function openDb(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  try {
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export function schemaVersion(db: DB): number {
  return db.pragma("user_version", { simple: true }) as number;
}

/**
 * Brings the database to the latest schema: every migration it has not run
 * yet (`PRAGMA user_version` counts those it has), each in its own
 * transaction together with its version bump, so a crash leaves the database
 * at the last completed step.
 */
export function migrate(db: DB): void {
  const latest = MIGRATIONS.length;
  const current = schemaVersion(db);
  if (current > latest) {
    throw new Error(
      `${db.name} is at schema version ${current}, newer than this server knows (${latest}): ` +
        "it was opened by a newer version of AI Activity. Upgrade the server instead of downgrading the database."
    );
  }
  for (let v = current; v < latest; v++) {
    // IMMEDIATE takes the write lock first: the server and the CLI
    // (npm run user, gen-key) may open the same file at the same time, and
    // whichever gets it second sees the step done and skips it.
    db.transaction(() => {
      if (schemaVersion(db) !== v) return;
      MIGRATIONS[v](db);
      db.pragma(`user_version = ${v + 1}`);
    }).immediate();
  }
}
