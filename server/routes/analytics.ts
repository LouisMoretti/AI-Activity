import { createHmac, randomBytes } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { SiteAnalyticsOverview } from "../../shared/types.ts";
import type { DB } from "../db/schema.ts";
import type { ClientInfo } from "../lib/client.ts";
import { readJson } from "../lib/http.ts";

const PAGES = new Set(["signin", "profile", "leaderboard", "demo", "friends", "settings", "admin"]);
/** Daily aggregates (page views, visitors, API calls) are kept this long. */
const RETENTION_DAYS = 90;
/** A browser's id lives 13 months (web/src/lib/visitor.ts); its first/last day a little longer. */
const KNOWN_VISITOR_DAYS = 400;
const OVERVIEW_DAYS = 30;
/** A visible tab pings every 30 s; one missed ping still counts as online. */
const ONLINE_MS = 60_000;
/** Minutes of online history kept in memory for the admin chart. */
const ONLINE_MINUTES = 60;
/** Distinct entries held in memory at once (presence, pending writes); beyond it, new ones are dropped. */
const MAX_TRACKED = 10_000;
/** Pending counts are written at most this often, so analytics barely touch the public read cache. */
const FLUSH_MS = 60_000;
/** The browser's random id: 128 bits, hex. */
const VISITOR_TOKEN = /^[0-9a-f]{32}$/;
const PROFILE_ROUTES = new Set(["stats", "activity", "quotas", "summary", "sessions"]);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const day = () => isoDay(Date.now());
const hmac = (key: string, ...parts: string[]) => createHmac("sha256", key).update(parts.join("\0")).digest("hex");

/** Host name of a URL or a bare host, lowercased, without "www."; null if none. */
function hostOf(value: string | undefined | null): string | null {
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase().replace(/^www\./, "").slice(0, 253) || null;
  } catch {
    return null;
  }
}

const siteHostOf = (c: Context) => (c.req.header("host") ?? "").split(":")[0].toLowerCase().replace(/^www\./, "");

/** External referrer host, or "direct". */
function sourceHost(value: unknown, siteHost: string): string {
  const host = typeof value === "string" ? hostOf(value) : null;
  return !host || host === siteHost ? "direct" : host;
}

/** What kind of program called the API, from its user agent (never stored itself). */
export function clientKind(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  if (!ua) return "none";
  if (/bot|crawl|spider|slurp|preview|facebookexternalhit|embed|monitor|uptime/.test(ua)) return "bot";
  if (ua.startsWith("curl/")) return "curl";
  if (ua.startsWith("wget/")) return "wget";
  if (/python|aiohttp|httpx|urllib/.test(ua)) return "python";
  if (/^node|undici|axios|node-fetch|got\b/.test(ua)) return "node";
  if (ua.startsWith("deno/")) return "deno";
  if (ua.startsWith("bun/")) return "bun";
  if (ua.startsWith("go-http-client")) return "go";
  if (/^mozilla\//.test(ua)) return "browser";
  return "other";
}

/** Category of a public API path, never a profile name: "profile.stats", "leaderboard"… */
function routeOf(path: string): string {
  const parts = path.replace(/^\/api\//, "").split("/").filter(Boolean);
  if (parts[0] !== "u") return parts[0] ?? "other";
  if (parts.length <= 2) return "profile";
  return `profile.${PROFILE_ROUTES.has(parts[2]) ? parts[2] : "other"}`;
}

/**
 * Hash keys, stored in `settings` so a restart counts nobody twice: one
 * permanent key for browser ids (they are random, so their HMAC links
 * nothing but the visits of that browser), and one rotated every UTC day
 * for address + user agent (clients without an id, API callers).
 */
function hashKeys(db: DB) {
  const read = db.prepare("SELECT value FROM settings WHERE key = ?");
  const write = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const stored = (key: string) => (read.get(key) as { value: string } | undefined)?.value;
  let permanent = stored("analytics_key");
  if (!permanent) write.run("analytics_key", (permanent = randomBytes(32).toString("hex")));
  let daily = stored("analytics_daily_key") ?? "";
  return {
    permanent: permanent!,
    daily(date: string): string {
      if (!daily.startsWith(`${date}:`)) write.run("analytics_daily_key", (daily = `${date}:${randomBytes(32).toString("hex")}`));
      return daily;
    },
  };
}

export function recordSignup(db: DB): void {
  db.prepare(`INSERT INTO site_analytics_signups(day, signups) VALUES (?, 1)
    ON CONFLICT(day) DO UPDATE SET signups = signups + 1`).run(day());
}

/**
 * Who is on the site now, in memory only (never written to the database):
 * each visitor's hash, last page category and last ping, plus the distinct
 * visitors of each of the last 60 minutes. A restart forgets it.
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

/** Counts waiting to be written, keyed by their row's primary key joined with "\0". */
function pending() {
  const counts = { pageviews: new Map<string, number>(), api: new Map<string, number>() };
  const sets = { visitors: new Set<string>(), apiClients: new Set<string>() };
  const full = () => counts.pageviews.size + counts.api.size + sets.visitors.size + sets.apiClients.size >= MAX_TRACKED * 5;
  return {
    counts, sets,
    add(map: Map<string, number>, ...key: string[]) {
      const k = key.join("\0");
      if (map.has(k) || !full()) map.set(k, (map.get(k) ?? 0) + 1);
    },
    put(set: Set<string>, ...key: string[]) {
      if (!full()) set.add(key.join("\0"));
    },
    clear() {
      counts.pageviews.clear(); counts.api.clear(); sets.visitors.clear(); sets.apiClients.clear();
    },
  };
}

export function createSiteAnalytics(db: DB, client: ClientInfo) {
  const keys = hashKeys(db);
  const online = presence();
  const queue = pending();
  let prunedDay = "";

  const write = db.transaction(() => {
    const view = db.prepare(`INSERT INTO site_analytics_pageviews(day, page, source, views) VALUES (?, ?, ?, ?)
      ON CONFLICT(day, page, source) DO UPDATE SET views = views + excluded.views`);
    for (const [k, n] of queue.counts.pageviews) view.run(...k.split("\0"), n);
    const visitor = db.prepare("INSERT OR IGNORE INTO site_analytics_visitors(day, visitor_hash) VALUES (?, ?)");
    const known = db.prepare(`INSERT INTO site_analytics_known_visitors(visitor_hash, first_day, last_day) VALUES (?, ?, ?)
      ON CONFLICT(visitor_hash) DO UPDATE SET first_day = min(first_day, excluded.first_day), last_day = max(last_day, excluded.last_day)`);
    for (const k of queue.sets.visitors) {
      const [date, hash] = k.split("\0");
      visitor.run(date, hash);
      if (hash.startsWith("v:")) known.run(hash, date, date);
    }
    const call = db.prepare(`INSERT INTO site_analytics_api_calls(day, route, origin, client, calls) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(day, route, origin, client) DO UPDATE SET calls = calls + excluded.calls`);
    for (const [k, n] of queue.counts.api) call.run(...k.split("\0"), n);
    const apiClient = db.prepare("INSERT OR IGNORE INTO site_analytics_api_clients(day, client_hash) VALUES (?, ?)");
    for (const k of queue.sets.apiClients) apiClient.run(...k.split("\0"));
    queue.clear();
    // Retention: once a day is enough.
    const today = day();
    if (prunedDay === today) return;
    prunedDay = today;
    const cutoff = isoDay(Date.now() - RETENTION_DAYS * 86400000);
    for (const table of ["site_analytics_pageviews", "site_analytics_visitors", "site_analytics_signups", "site_analytics_api_calls", "site_analytics_api_clients"]) {
      db.prepare(`DELETE FROM ${table} WHERE day < ?`).run(cutoff);
    }
    db.prepare("DELETE FROM site_analytics_known_visitors WHERE last_day < ?").run(isoDay(Date.now() - KNOWN_VISITOR_DAYS * 86400000));
  });
  /** Writes what is pending (every minute, before the admin reads, and at shutdown). */
  function flush(): void {
    if (!db.open) return;
    const empty = !queue.counts.pageviews.size && !queue.counts.api.size && !queue.sets.visitors.size && !queue.sets.apiClients.size;
    if (empty && prunedDay === day()) return;
    try { write(); } catch (err) { console.error("site analytics flush failed:", err); }
  }
  setInterval(flush, FLUSH_MS).unref();

  /** The browser's id when it sent one ("v:"), else its address and user agent for today only ("d:"). */
  function visitorOf(c: Context, date: string, token: unknown): string {
    if (typeof token === "string" && VISITOR_TOKEN.test(token)) return `v:${hmac(keys.permanent, "visitor", token)}`;
    return `d:${hmac(keys.daily(date), "visitor", client.clientId(c), c.req.header("user-agent") ?? "")}`;
  }

  async function pageBody(c: Context) {
    const body = await readJson(c);
    return typeof body.page === "string" && PAGES.has(body.page) ? { page: body.page, visitor: body.visitor, referrer: body.referrer } : null;
  }

  const routes = new Hono()
    .post("/view", async (c) => {
      const body = await pageBody(c);
      if (!body) return c.json({ error: "invalid page" }, 400);
      const date = day();
      const visitor = visitorOf(c, date, body.visitor);
      queue.add(queue.counts.pageviews, date, body.page, sourceHost(body.referrer, siteHostOf(c)));
      queue.put(queue.sets.visitors, date, visitor);
      online.touch(visitor, body.page);
      return c.body(null, 204);
    })
    // Heartbeat of a visible tab: memory only.
    .post("/ping", async (c) => {
      const body = await pageBody(c);
      if (!body) return c.json({ error: "invalid page" }, 400);
      online.touch(visitorOf(c, day(), body.visitor), body.page);
      return c.body(null, 204);
    });

  /**
   * Counts reads of the public API by other programs and sites (this site's
   * own pages are same-origin and counted as page views instead): route
   * category, the calling site's host (Origin, else Referer; "none" from a
   * server or script) and client kind. Mounted before the rate limit and
   * the read cache, so throttled and cached answers count too.
   */
  const trackApi: MiddlewareHandler = async (c, next) => {
    const fetchSite = c.req.header("sec-fetch-site");
    const siteHost = siteHostOf(c);
    const from = hostOf(c.req.header("origin")) ?? hostOf(c.req.header("referer"));
    const own = fetchSite === "same-origin" || (!fetchSite && from === siteHost);
    if (!own && c.req.method === "GET") {
      const date = day();
      const ua = c.req.header("user-agent") ?? "";
      queue.add(queue.counts.api, date, routeOf(c.req.path), from && from !== siteHost ? from : "none", clientKind(ua));
      queue.put(queue.sets.apiClients, date, hmac(keys.daily(date), "api", client.clientId(c), ua));
    }
    await next();
  };

  /** 30-day aggregates (every day, zeros included) and who is online; no viewer or account dimensions. */
  function overview(): SiteAnalyticsOverview {
    flush();
    const now = Date.now();
    const since = isoDay(now - (OVERVIEW_DAYS - 1) * 86400000);
    type Count = { day: string; n: number };
    const byDay = (sql: string) => new Map((db.prepare(sql).all(since) as Count[]).map((r) => [r.day, r.n]));
    const views = byDay("SELECT day, SUM(views) AS n FROM site_analytics_pageviews WHERE day >= ? GROUP BY day");
    const visitors = byDay("SELECT day, COUNT(*) AS n FROM site_analytics_visitors WHERE day >= ? GROUP BY day");
    const newVisitors = byDay(`SELECT v.day, COUNT(*) AS n FROM site_analytics_visitors v
      JOIN site_analytics_known_visitors k ON k.visitor_hash = v.visitor_hash
      WHERE v.day >= ? AND k.first_day = v.day GROUP BY v.day`);
    const returning = byDay(`SELECT v.day, COUNT(*) AS n FROM site_analytics_visitors v
      JOIN site_analytics_known_visitors k ON k.visitor_hash = v.visitor_hash
      WHERE v.day >= ? AND k.first_day < v.day GROUP BY v.day`);
    const signups = byDay("SELECT day, signups AS n FROM site_analytics_signups WHERE day >= ?");
    const calls = byDay("SELECT day, SUM(calls) AS n FROM site_analytics_api_calls WHERE day >= ? GROUP BY day");
    const clients = byDay("SELECT day, COUNT(*) AS n FROM site_analytics_api_clients WHERE day >= ? GROUP BY day");
    const dense = (f: (d: string) => object) => Array.from({ length: OVERVIEW_DAYS }, (_, i) => {
      const d = isoDay(now - (OVERVIEW_DAYS - 1 - i) * 86400000);
      return { day: d, ...f(d) };
    });
    const top = <T>(sql: string) => db.prepare(sql).all(since) as T[];
    return {
      days: dense((d) => ({
        pageviews: views.get(d) ?? 0, visitors: visitors.get(d) ?? 0,
        new_visitors: newVisitors.get(d) ?? 0, returning_visitors: returning.get(d) ?? 0,
        signups: signups.get(d) ?? 0,
      })) as SiteAnalyticsOverview["days"],
      unique_visitors: (db.prepare(`SELECT COUNT(DISTINCT visitor_hash) AS n FROM site_analytics_visitors
        WHERE day >= ?`).get(since) as { n: number }).n,
      pages: top(`SELECT page, SUM(views) AS views FROM site_analytics_pageviews
        WHERE day >= ? GROUP BY page ORDER BY views DESC, page`),
      sources: top(`SELECT source, SUM(views) AS views FROM site_analytics_pageviews
        WHERE day >= ? AND source != 'direct' GROUP BY source ORDER BY views DESC, source LIMIT 20`),
      online: online.snapshot(now),
      api: {
        days: dense((d) => ({ calls: calls.get(d) ?? 0, clients: clients.get(d) ?? 0 })) as SiteAnalyticsOverview["api"]["days"],
        routes: top(`SELECT route, SUM(calls) AS calls FROM site_analytics_api_calls
          WHERE day >= ? GROUP BY route ORDER BY calls DESC, route`),
        origins: top(`SELECT origin, SUM(calls) AS calls FROM site_analytics_api_calls
          WHERE day >= ? GROUP BY origin ORDER BY calls DESC, origin LIMIT 20`),
        clients: top(`SELECT client, SUM(calls) AS calls FROM site_analytics_api_calls
          WHERE day >= ? GROUP BY client ORDER BY calls DESC, client`),
      },
    };
  }

  return { routes, trackApi, overview, flush };
}

export type SiteAnalytics = ReturnType<typeof createSiteAnalytics>;
