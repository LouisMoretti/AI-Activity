import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Config } from "./config.ts";
import type { DB } from "./db/schema.ts";
import { limitBody } from "./lib/http.ts";
import { createViewerAuth } from "./lib/viewer-auth.ts";
import { accountRoutes, userRoutes } from "./routes/account.ts";
import { authRoutes } from "./routes/auth.ts";
import { billingRoutes } from "./routes/billing.ts";
import { deviceRoutes } from "./routes/devices.ts";
import { ingestRoutes } from "./routes/ingest.ts";
import { usageRoutes } from "./routes/usage.ts";

export function createApp(db: DB, config: Config) {
  const auth = createViewerAuth(db);

  const api = new Hono()
    .use(limitBody(256 * 1024))
    .use(async (c, next) => {
      await next();
      c.header("cache-control", "no-store");
    })
    .get("/health", (c) => c.json({ ok: true }))
    .route("/auth", authRoutes(db, auth))
    .route("/ingest", ingestRoutes(db))
    // Everything below requires a viewer session.
    .use(auth.require)
    .route("/", usageRoutes(db))
    .route("/billing", billingRoutes(db))
    .route("/devices", deviceRoutes(db))
    .route("/account", accountRoutes(db, auth))
    .route("/users", userRoutes(db));

  const indexFile = path.join(config.staticDir, "index.html");
  // Served from memory; an async stat per request picks up a rebuilt web
  // root (new hashed asset names) without a restart or blocking I/O.
  let index: { mtimeMs: number; html: string } | null = null;
  const loadIndex = async (): Promise<string | null> => {
    try {
      const { mtimeMs } = await fs.promises.stat(indexFile);
      if (index?.mtimeMs !== mtimeMs) index = { mtimeMs, html: await fs.promises.readFile(indexFile, "utf8") };
      return index.html;
    } catch {
      index = null;
      return null;
    }
  };

  const app = new Hono()
    .route("/api", api)
    .all("/api/*", (c) => c.json({ error: "not found" }, 404))
    .use("*", serveStatic({ root: config.staticDir }))
    // SPA fallback for unknown non-API paths.
    .get("*", async (c) => {
      const html = await loadIndex();
      return html === null ? c.text("not found", 404) : c.html(html);
    });

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    // Details stay in the server log; the public tunnel only sees a generic error.
    console.error(err);
    return c.json({ error: "internal server error" }, 500);
  });

  return app;
}
