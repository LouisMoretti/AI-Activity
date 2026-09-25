import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { accountsExist } from "./db/queries.ts";
import { openDb } from "./db/schema.ts";
import { bootstrapAccounts } from "./lib/accounts.ts";
import { newSetupCode } from "./lib/setup.ts";

const config = loadConfig();
const db = openDb(config.dbPath);
const bootstrapped = await bootstrapAccounts(db, config);
// New on every start and only in this log: whoever creates the first
// account from the browser must be able to read the server's output.
const setupCode = accountsExist(db) ? null : newSetupCode();

const server = serve({ fetch: createApp(db, config, setupCode).fetch, port: config.port }, () => {
  console.log(`AI Activity Dashboard listening on http://localhost:${config.port}`);
  console.log(`DB: ${config.dbPath}`);
  if (bootstrapped) console.log(`Created account "${bootstrapped}" from DASHBOARD_PASSWORD`);
  if (setupCode) {
    console.log("No account yet. Create the first one in the browser with this setup code:");
    console.log(`  Setup code: ${setupCode}`);
    console.log("(or run npm run user -- add <username>)");
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
