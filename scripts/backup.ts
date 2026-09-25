// A consistent backup of the live database, safe while the server runs:
//   npm run backup [-- --out <dir>] [--keep-daily 7] [--keep-weekly 4]
// Writes <dir>/dashboard-YYYYMMDD-HHMMSS.db (UTC), checks it, then prunes
// older backups: the newest of each of the last 7 days and 4 ISO weeks stay.
// <dir> defaults to BACKUP_DIR, else data/backups next to the database.
import Database from "better-sqlite3";
import { loadConfig } from "../server/config.ts";
import { backupTo, pruneBackups } from "../server/lib/backup.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
};
const count = (name: string, fallback: number) => {
  const v = option(name);
  if (v === null) return fallback;
  if (!/^\d+$/.test(v)) {
    console.error(`${name} needs a whole number`);
    process.exit(1);
  }
  return Number(v);
};

const config = loadConfig();
const dir = option("--out") ?? config.backupDir;
const daily = count("--keep-daily", 7);
const weekly = count("--keep-weekly", 4);

try {
  // Opened as is, never migrated: a backup must not change the database.
  const db = new Database(config.dbPath, { fileMustExist: true });
  let result;
  try {
    result = backupTo(db, dir);
  } finally {
    db.close();
  }
  console.log(`Backup: ${result.file} (${(result.bytes / 1024).toFixed(0)} KB, ${result.events} events, schema v${result.version}, integrity ok)`);
  for (const f of pruneBackups(dir, config.dbPath, { daily, weekly })) console.log(`Pruned: ${f}`);
} catch (err) {
  console.error(`Backup failed: ${(err as Error).message}`);
  process.exit(1);
}
