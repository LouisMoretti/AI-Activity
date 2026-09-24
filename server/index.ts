import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db/schema.ts";

const config = loadConfig();
const db = openDb(config.dbPath);

serve({ fetch: createApp(db, config).fetch, port: config.port }, () => {
  console.log(`AI usage dashboard listening on http://localhost:${config.port}`);
  console.log(`DB: ${config.dbPath}`);
  if (!config.viewerPassword) console.log("Viewer auth: disabled (no DASHBOARD_PASSWORD set)");
});
