import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { accountsExist } from "./db/queries.ts";
import { openDb } from "./db/schema.ts";
import { bootstrapAccounts } from "./lib/accounts.ts";

const config = loadConfig();
const db = openDb(config.dbPath);
const bootstrapped = await bootstrapAccounts(db, config);

const server = serve({ fetch: createApp(db, config).fetch, port: config.port }, () => {
  console.log(`AI usage dashboard listening on http://localhost:${config.port}`);
  console.log(`DB: ${config.dbPath}`);
  if (bootstrapped) console.log(`Created account "${bootstrapped}" from DASHBOARD_PASSWORD`);
  if (!accountsExist(db)) {
    console.log("No account yet: nothing is viewable until you run npm run user -- add <username>");
  }
});

// Stop accepting requests, then close SQLite so the WAL is checkpointed.
function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  if ("closeIdleConnections" in server) server.closeIdleConnections();
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
