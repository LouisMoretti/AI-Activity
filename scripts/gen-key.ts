// npm run gen-key -- "<device name>" [--user <username>]
import { loadConfig } from "../server/config.ts";
import { createDevice, findUserByUsername, getDefaultUserId } from "../server/db/queries.ts";
import { openDb } from "../server/db/schema.ts";

const args = process.argv.slice(2);
const u = args.indexOf("--user");
const username = u >= 0 ? args.splice(u, 2)[1] : null;
const config = loadConfig();
const db = openDb(config.dbPath, config.backupDir);
const name = args[0] || "unnamed device";
const user = username ? findUserByUsername(db, username) : null;
if (username && !user) {
  console.error(`no user "${username}"`);
  process.exit(1);
}
const { id, key } = createDevice(db, { userId: user?.id ?? getDefaultUserId(db), name });
console.log(`Device #${id} (${name}) created${user ? ` for ${user.username}` : ""}.`);
console.log(`Ingestion key (also copyable later from Settings → Devices):\n${key}`);
console.log(`Header for POSTs: Authorization: Bearer ${key}`);
db.close();
