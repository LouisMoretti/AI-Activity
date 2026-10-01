import { createHmac, randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { DB } from "../db/schema.ts";
import type { ClientInfo } from "../lib/client.ts";
import { readJson } from "../lib/http.ts";

const PAGES = new Set(["signin", "profile", "leaderboard", "demo", "friends", "settings", "admin"]);
const RETENTION_DAYS = 90;
const day = () => new Date().toISOString().slice(0, 10);

/** Hash an address and user agent with a process-local key that rotates daily. */
function visitorHasher() {
  let secretDay = "";
  let secret = randomBytes(32);
  return (date: string, address: string, userAgent: string) => {
    if (date !== secretDay) {
      secretDay = date;
      secret = randomBytes(32);
    }
    return createHmac("sha256", secret).update(address).update("\0").update(userAgent).digest("hex");
  };
}

function sourceHost(value: unknown, siteHost: string): string {
  if (typeof value !== "string" || value.length > 2048) return "direct";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "direct";
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return !host || host === siteHost || host === siteHost.replace(/^www\./, "") ? "direct" : host;
  } catch {
    return "direct";
  }
}

export function recordSignup(db: DB): void {
  const today = day();
  db.prepare(`INSERT INTO site_analytics_signups(day, signups) VALUES (?, 1)
    ON CONFLICT(day) DO UPDATE SET signups = signups + 1`).run(today);
}

export function siteAnalyticsRoutes(db: DB, client: ClientInfo, enabled: boolean) {
  const hashVisitor = visitorHasher();
  const recordView = db.transaction((date: string, page: string, source: string, visitor: string) => {
    db.prepare(`INSERT INTO site_analytics_pageviews(day, page, source, views) VALUES (?, ?, ?, 1)
      ON CONFLICT(day, page, source) DO UPDATE SET views = views + 1`).run(date, page, source);
    db.prepare("INSERT OR IGNORE INTO site_analytics_visitors(day, visitor_hash) VALUES (?, ?)").run(date, visitor);
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
    db.prepare("DELETE FROM site_analytics_pageviews WHERE day < ?").run(cutoff);
    db.prepare("DELETE FROM site_analytics_visitors WHERE day < ?").run(cutoff);
    db.prepare("DELETE FROM site_analytics_signups WHERE day < ?").run(cutoff);
  });

  return new Hono()
    .post("/view", async (c) => {
      if (!enabled) return c.body(null, 204);
      const body = await readJson(c);
      if (typeof body.page !== "string" || !PAGES.has(body.page)) return c.json({ error: "invalid page" }, 400);
      const date = day();
      const siteHost = (c.req.header("host") ?? "").split(":")[0].toLowerCase();
      const source = sourceHost(body.referrer, siteHost);
      const visitor = hashVisitor(date, client.clientId(c), c.req.header("user-agent") ?? "");
      recordView(date, body.page, source, visitor);
      return c.body(null, 204);
    });
}

/** 30-day aggregates for the admin panel; no viewer or account dimensions. */
export function siteAnalyticsOverview(db: DB) {
  const since = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const views = db.prepare(`SELECT day, SUM(views) AS pageviews FROM site_analytics_pageviews
    WHERE day >= ? GROUP BY day ORDER BY day`).all(since) as { day: string; pageviews: number }[];
  const visitors = db.prepare(`SELECT day, COUNT(*) AS visitors FROM site_analytics_visitors
    WHERE day >= ? GROUP BY day ORDER BY day`).all(since) as { day: string; visitors: number }[];
  const signups = db.prepare(`SELECT day, signups FROM site_analytics_signups
    WHERE day >= ? ORDER BY day`).all(since) as { day: string; signups: number }[];
  const pages = db.prepare(`SELECT page, SUM(views) AS views FROM site_analytics_pageviews
    WHERE day >= ? GROUP BY page ORDER BY views DESC, page`).all(since) as { page: string; views: number }[];
  const sources = db.prepare(`SELECT source, SUM(views) AS views FROM site_analytics_pageviews
    WHERE day >= ? AND source != 'direct' GROUP BY source ORDER BY views DESC, source LIMIT 20`)
    .all(since) as { source: string; views: number }[];
  const days = new Map<string, { pageviews: number; visitors: number; signups: number }>();
  for (const row of views) days.set(row.day, { pageviews: row.pageviews, visitors: 0, signups: 0 });
  for (const row of visitors) days.set(row.day, { ...(days.get(row.day) ?? { pageviews: 0, signups: 0 }), visitors: row.visitors });
  for (const row of signups) days.set(row.day, { ...(days.get(row.day) ?? { pageviews: 0, visitors: 0 }), signups: row.signups });
  return { days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, totals]) => ({ day: date, ...totals })), pages, sources };
}
