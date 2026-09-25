// Replace the database with a backup (stop the server first):
//   npm run restore -- <backup file>
// The current database is backed up first (…-pre-restore.db). Sessions are
// rolled back too: users may need to sign in again.
import { loadConfig } from "../server/config.ts";
import { MIGRATIONS } from "../server/db/migrations.ts";
import { restoreFrom } from "../server/lib/backup.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: npm run restore -- <backup file>");
  process.exit(1);
}
const config = loadConfig();
try {
  const saved = restoreFrom(file, config.dbPath, config.backupDir, MIGRATIONS.length);
  if (saved) console.log(`Previous database saved as ${saved.file}`);
  console.log(`Restored ${file} to ${config.dbPath}. Start the server; users may need to sign in again.`);
} catch (err) {
  console.error(`Restore failed: ${(err as Error).message}`);
  process.exit(1);
}
