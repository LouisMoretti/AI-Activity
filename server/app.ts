import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Config } from "./config.ts";
import type { DB } from "./db/schema.ts";
import { clientInfo } from "./lib/client.ts";
import { securityHeaders } from "./lib/headers.ts";
import { buildInstallers } from "./lib/installer.ts";
import { jsonOnly, limitBody, readCache } from "./lib/http.ts";
import type { LiteLLM } from "./lib/litellm.ts";
import { LIMITS, rateLimit, tokenBuckets } from "./lib/rate-limit.ts";
import { createViewerAuth } from "./lib/viewer-auth.ts";
import { accountRoutes, adminRoutes, userRoutes } from "./routes/account.ts";
import { createSiteAnalytics } from "./routes/analytics.ts";
import { authRoutes } from "./routes/auth.ts";
import { deviceRoutes } from "./routes/devices.ts";
import { friendsRoutes } from "./routes/friends.ts";
import { ingestRoutes } from "./routes/ingest.ts";
import { leaderboardRoutes, profileListRoutes, publicProfileRoutes } from "./routes/usage.ts";

/**
 * setupCode: one-time code for creating the first account from the browser
 * (null once one exists). litellm: the fallback pricing catalog (none: only
 * the priority pricing file prices usage).
 */
export function createApp(db: DB, config: Config, setupCode: string | null = null, litellm: LiteLLM | null = null) {
  const catalog = () => litellm?.catalog() ?? null;
  const client = clientInfo(config.trustProxy);
  const auth = createViewerAuth(db, client, config.allowedLogins);
  const cache = readCache(db);
  const publicReads = rateLimit(tokenBuckets(LIMITS.publicReads), (c) => auth.clientId(c));
  const perUser = rateLimit(tokenBuckets(LIMITS.sessionRequests), (c) => String(c.get("userId")));
  const oauth = rateLimit(tokenBuckets(LIMITS.oauth), (c) => auth.clientId(c));
  const analyticsPosts = rateLimit(tokenBuckets(LIMITS.analytics), (c) => auth.clientId(c));
  const analytics = createSiteAnalytics(db, client);

  const api = new Hono()
    .use(limitBody(256 * 1024))
    .use(jsonOnly)
    .use(async (c, next) => {
      await next();
      c.header("cache-control", "no-store");
    })
    .use(analytics.trackLimited)
    .get("/health", (c) => c.json({ ok: true }))
    // Starting a GitHub sign-in, per client. Not GitHub's callback: a
    // successful sign-in must not cost twice, and the callback only works
    // with a state this server just handed out.
    .on("POST", "/auth/github", oauth)
    .on("POST", ["/analytics/view", "/analytics/ping"], analyticsPosts)
    .route("/auth", authRoutes(db, auth, client, config.github, config.publicUrl, setupCode, config.preview))
    .route("/analytics", analytics.routes)
    .route("/ingest", ingestRoutes(db))
    // Public, read-only: profile pages, the account list and the leaderboard.
    // External reads are counted around the rate limit and the cache (cached ones count).
    .use("/u/*", analytics.trackApi)
    .use("/leaderboard", analytics.trackApi)
    .use("/profiles", analytics.trackApi)
    .use("/u/*", publicReads)
    .use("/leaderboard", publicReads)
    .use("/profiles", publicReads)
    .use("/u/*", cache)
    .use("/leaderboard", cache)
    .route("/u/:username", publicProfileRoutes(db, catalog))
    .route("/leaderboard", leaderboardRoutes(db, catalog))
    .route("/profiles", profileListRoutes(db))
    // Everything below requires a viewer session.
    .use(auth.require)
    .use(perUser)
    .route("/friends", friendsRoutes(db, config.github))
    .route("/devices", deviceRoutes(db))
    .route("/account", accountRoutes(db))
    .route("/users", userRoutes(db))
    .route("/admin", adminRoutes(db, analytics, config.preview, litellm));

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

  // Built once: the collectors only change with a new server version.
  const installers = buildInstallers();

  const app = new Hono()
    .use(securityHeaders(client))
    .route("/api", api)
    .all("/api/*", (c) => c.json({ error: "not found" }, 404))
    .get("/install.sh", (c) => {
      c.header("cache-control", "no-store");
      return c.body(installers.sh, 200, { "content-type": "text/plain; charset=utf-8" });
    })
    .get("/install.ps1", (c) => {
      c.header("cache-control", "no-store");
      return c.body(installers.ps1, 200, { "content-type": "text/plain; charset=utf-8" });
    })
    .use("*", serveStatic({
      root: config.staticDir,
      // Vite names everything under assets/ (bundles, fonts) by content hash:
      // a new build means new names. The rest (index.html, tool logos) is
      // revalidated, so a deploy shows up at once.
      onFound: (_path, c) => {
        c.header("cache-control", c.req.path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      },
    }))
    // SPA fallback for unknown non-API paths.
    .get("*", async (c) => {
      const html = await loadIndex();
      c.header("cache-control", "no-cache");
      return html === null ? c.text("not found", 404) : c.html(html);
    });

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    // Details stay in the server log; the public tunnel only sees a generic error.
    console.error(err);
    return c.json({ error: "internal server error" }, 500);
  });

  /** Writes pending analytics counts; call before closing the database. */
  return Object.assign(app, { flushAnalytics: analytics.flush });
}
