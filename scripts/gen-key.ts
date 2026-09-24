import { loadConfig } from "../server/config.ts";
import { createDevice, getDefaultUserId } from "../server/db/queries.ts";
import { openDb } from "../server/db/schema.ts";

const db = openDb(loadConfig().dbPath);
const name = process.argv[2] || "unnamed device";
const { id, key } = createDevice(db, { userId: getDefaultUserId(db), name });
console.log(`Device #${id} (${name}) created.`);
console.log(`Ingestion key (shown once, store it on the device):\n${key}`);
console.log(`Header for POSTs: Authorization: Bearer ${key}`);
db.close();
