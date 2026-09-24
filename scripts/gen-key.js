import { openDb, getDefaultUserId, createDevice } from "../db.js";
import path from "node:path";

const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "dashboard.db");
const db = openDb(dbPath);
const name = process.argv[2] || "unnamed device";
const { id, key } = createDevice(db, { userId: getDefaultUserId(db), name });
console.log(`Device #${id} (${name}) created.`);
console.log(`Ingestion key (shown once, store it on the device):\n${key}`);
console.log(`Header for POSTs: Authorization: Bearer ${key}`);
db.close();
