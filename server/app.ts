import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Config } from "./config.ts";
import { getDefaultUserId } from "./db/queries.ts";
import type { DB } from "./db/schema.ts";
import { limitBody } from "./lib/http.ts";
import { createViewerAuth } from "./lib/viewer-auth.ts";
import { authRoutes } from "./routes/auth.ts";
import { billingRoutes } from "./routes/billing.ts";
import { deviceRoutes } from "./routes/devices.ts";
import { ingestRoutes } from "./routes/ingest.ts";
import { usageRoutes } from "./routes/usage.ts";

export function createApp(db: DB, config: Config) {
  const auth = createViewerAuth(config.viewerPassword);
  const userId = () => getDefaultUserId(db); // multi-user login comes later

  const api = new Hono()
    .use(limitBody(256 * 1024))
    .use(async (c, next) => {
      await next();
      c.header("cache-control", "no-store");
    })
    .get("/health", (c) => c.json({ ok: true }))
    .route("/auth", authRoutes(auth))
    .route("/ingest", ingestRoutes(db))
    // Everything below requires a viewer session.
    .use(auth.require)
    .route("/", usageRoutes(db, userId))
    .route("/billing", billingRoutes(db, userId))
    .route("/devices", deviceRoutes(db, userId));

  const indexFile = path.join(config.staticDir, "index.html");

  const app = new Hono()
    .route("/api", api)
    .all("/api/*", (c) => c.json({ error: "not found" }, 404))
    .use("*", serveStatic({ root: config.staticDir }))
    // SPA fallback for unknown non-API paths.
    .get("*", (c) =>
      fs.existsSync(indexFile)
        ? c.html(fs.readFileSync(indexFile, "utf8"))
        : c.text("not found", 404));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: String(err?.message || err) }, 500);
  });

  return app;
}
