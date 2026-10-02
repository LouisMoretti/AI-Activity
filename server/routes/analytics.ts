import { createHmac, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import type { SiteAnalyticsOverview } from "../../shared/types.ts";
import type { DB } from "../db/schema.ts";
import type { ClientInfo } from "../lib/client.ts";
import { readJson } from "../lib/http.ts";

const PAGES = new Set(["signin", "profile", "leaderboard", "demo", "friends", "settings", "admin"]);
const RETENTION_DAYS = 90;
const OVERVIEW_DAYS = 30;
/** A visible tab pings every 30 s; one missed ping still counts as online. */
const ONLINE_MS = 60_000;
/** Minutes of online history kept in memory for the admin chart. */
const ONLINE_MINUTES = 60;
/** Distinct visitors tracked in memory at once; beyond it, new ones are not added. */
const MAX_TRACKED = 10_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const day = () => isoDay(Date.now());

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

/** External referrer host, or "direct". Takes a URL or a bare host name. */
function sourceHost(value: unknown, siteHost: string): string {
  if (typeof value !== "string" || !value || value.length > 2048) return "direct";
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "direct";
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return !host || host === siteHost.replace(/^www\./, "") ? "direct" : host;
  } catch {
    return "direct";
  }
}

export function recordSignup(db: DB): void {
  db.prepare(`INSERT INTO site_analytics_signups(day, signups) VALUES (?, 1)
    ON CONFLICT(day) DO UPDATE SET signups = signups + 1`).run(day());
}

/**
 * Who is on the site now, in memory only (never written to the database):
 * each visitor's daily hash, last page category and last ping, plus the
 * distinct visitors of each of the last 60 minutes. A restart forgets it.
 */
function presence() {
  const seen = new Map<string, { at: number; page: string }>();
  const minutes = new Map<number, Set<string>>();
  const prune = (now: number) => {
    for (const [hash, v] of seen) if (now - v.at > ONLINE_MS) seen.delete(hash);
    const oldest = Math.floor(now / 60_000) - ONLINE_MINUTES + 1;
    for (const m of minutes.keys()) if (m < oldest) minutes.delete(m);
  };
  let prunedAt = 0;
  return {
    touch(visitor: string, page: string, now = Date.now()) {
      if (now - prunedAt > 10_000) { prune(now); prunedAt = now; }
      if (!seen.has(visitor) && seen.size >= MAX_TRACKED) return;
      seen.set(visitor, { at: now, page });
      const minute = Math.floor(now / 60_000);
      let set = minutes.get(minute);
      if (!set) minutes.set(minute, (set = new Set()));
      if (set.size < MAX_TRACKED) set.add(visitor);
    },
    snapshot(now = Date.now()): SiteAnalyticsOverview["online"] {
      prune(now);
      const pages = new Map<string, number>();
      for (const v of seen.values()) pages.set(v.page, (pages.get(v.page) ?? 0) + 1);
      const current = Math.floor(now / 60_000);
      return {
        now: seen.size,
        pages: [...pages].map(([page, visitors]) => ({ page, visitors }))
          .sort((a, b) => b.visitors - a.visitors || a.page.localeCompare(b.page)),
        minutes: Array.from({ length: ONLINE_MINUTES }, (_, i) => minutes.get(current - ONLINE_MINUTES + 1 + i)?.size ?? 0),
      };
    },
  };
}

export function createSiteAnalytics(db: DB, client: ClientInfo) {
  const hashVisitor = visitorHasher();
  const online = presence();
  let prunedDay = "";
  const recordView = db.transaction((date: string, page: string, source: string, visitor: string) => {
    db.prepare(`INSERT INTO site_analytics_pageviews(day, page, source, views) VALUES (?, ?, ?, 1)
      ON CONFLICT(day, page, source) DO UPDATE SET views = views + 1`).run(date, page, source);
    db.prepare("INSERT OR IGNORE INTO site_analytics_visitors(day, visitor_hash) VALUES (?, ?)").run(date, visitor);
    // Retention: once a day is enough.
    if (prunedDay === date) return;
    prunedDay = date;
    const cutoff = isoDay(Date.now() - RETENTION_DAYS * 86400000);
    db.prepare("DELETE FROM site_analytics_pageviews WHERE day < ?").run(cutoff);
    db.prepare("DELETE FROM site_analytics_visitors WHERE day < ?").run(cutoff);
    db.prepare("DELETE FROM site_analytics_signups WHERE day < ?").run(cutoff);
  });
  const visitorOf = (c: Context, date: string) =>
    hashVisitor(date, client.clientId(c), c.req.header("user-agent") ?? "");

  const routes = new Hono()
    .post("/view", async (c) => {
      const body = await readJson(c);
      if (typeof body.page !== "string" || !PAGES.has(body.page)) return c.json({ error: "invalid page" }, 400);
      const date = day();
      const siteHost = (c.req.header("host") ?? "").split(":")[0].toLowerCase();
      const visitor = visitorOf(c, date);
      recordView(date, body.page, sourceHost(body.referrer, siteHost), visitor);
      online.touch(visitor, body.page);
      return c.body(null, 204);
    })
    // Heartbeat of a visible tab: memory only, so it never invalidates the public read cache.
    .post("/ping", async (c) => {
      const body = await readJson(c);
      if (typeof body.page !== "string" || !PAGES.has(body.page)) return c.json({ error: "invalid page" }, 400);
      online.touch(visitorOf(c, day()), body.page);
      return c.body(null, 204);
    });

  /** 30-day aggregates (every day, zeros included) and who is online; no viewer or account dimensions. */
  function overview(): SiteAnalyticsOverview {
    const now = Date.now();
    const since = isoDay(now - (OVERVIEW_DAYS - 1) * 86400000);
    const views = db.prepare(`SELECT day, SUM(views) AS n FROM site_analytics_pageviews
      WHERE day >= ? GROUP BY day`).all(since) as { day: string; n: number }[];
    const visitors = db.prepare(`SELECT day, COUNT(*) AS n FROM site_analytics_visitors
      WHERE day >= ? GROUP BY day`).all(since) as { day: string; n: number }[];
    const signups = db.prepare(`SELECT day, signups AS n FROM site_analytics_signups
      WHERE day >= ?`).all(since) as { day: string; n: number }[];
    const pages = db.prepare(`SELECT page, SUM(views) AS views FROM site_analytics_pageviews
      WHERE day >= ? GROUP BY page ORDER BY views DESC, page`).all(since) as { page: string; views: number }[];
    const sources = db.prepare(`SELECT source, SUM(views) AS views FROM site_analytics_pageviews
      WHERE day >= ? AND source != 'direct' GROUP BY source ORDER BY views DESC, source LIMIT 20`)
      .all(since) as { source: string; views: number }[];
    const byDay = (rows: { day: string; n: number }[]) => new Map(rows.map((r) => [r.day, r.n]));
    const [v, u, s] = [byDay(views), byDay(visitors), byDay(signups)];
    const days = Array.from({ length: OVERVIEW_DAYS }, (_, i) => {
      const d = isoDay(now - (OVERVIEW_DAYS - 1 - i) * 86400000);
      return { day: d, pageviews: v.get(d) ?? 0, visitors: u.get(d) ?? 0, signups: s.get(d) ?? 0 };
    });
    return { days, pages, sources, online: online.snapshot(now) };
  }

  return { routes, overview };
}

export type SiteAnalytics = ReturnType<typeof createSiteAnalytics>;
