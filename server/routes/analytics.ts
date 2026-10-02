import { createHmac, randomBytes } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { TOOLS, type SiteAnalyticsOverview } from "../../shared/types.ts";
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
/** New referrer or origin hosts recorded per UTC day each; beyond it they count as "other" (they come from the caller). */
const MAX_HOSTS_PER_DAY = 100;
const SESSION_ROUTES = new Set(["friends", "devices", "account", "users", "admin"]);
const TOOL_SLUGS = new Set<string>(TOOLS);
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

/**
 * Where a page view came from: "direct", an external referrer host, or
 * "sign-in:<host>" for the return from a sign-in provider (the client
 * marks it), kept apart so sign-ins never read as referrals.
 */
function sourceOf(referrer: unknown, via: unknown, siteHost: string): string {
  const host = typeof referrer === "string" ? hostOf(referrer) : null;
  if (via === "sign-in") return `sign-in:${host && host !== siteHost ? host : "unknown"}`;
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

/** What a refused (429) request was, from a fixed set: "public.leaderboard", "ingest.codex", "auth.github"… */
function limitedScope(path: string): string {
  const parts = path.replace(/^\/api\//, "").split("/").filter(Boolean);
  const [head, sub] = parts;
  if (head === "u" || head === "leaderboard" || head === "profiles") return `public.${routeOf(path)}`;
  if (head === "ingest") return `ingest.${sub && TOOL_SLUGS.has(sub) ? sub : "other"}`;
  if (head === "auth") return sub === "github" ? "auth.github" : "auth.other";
  if (head === "analytics") return sub === "view" || sub === "ping" ? `analytics.${sub}` : "analytics.other";
  if (head && SESSION_ROUTES.has(head)) return `session.${head}`;
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
  const counts = { pageviews: new Map<string, number>(), api: new Map<string, number>(), limited: new Map<string, number>() };
  const sets = { visitors: new Set<string>(), apiClients: new Set<string>(), limitedClients: new Set<string>() };
  const size = () => [...Object.values(counts), ...Object.values(sets)].reduce((n, m) => n + m.size, 0);
  const full = () => size() >= MAX_TRACKED * 5;
  return {
    counts, sets,
    add(map: Map<string, number>, ...key: string[]) {
      const k = key.join("\0");
      if (map.has(k) || !full()) map.set(k, (map.get(k) ?? 0) + 1);
    },
    put(set: Set<string>, ...key: string[]) {
      if (!full()) set.add(key.join("\0"));
    },
    empty: () => size() === 0,
    clear() {
      for (const m of [...Object.values(counts), ...Object.values(sets)]) m.clear();
    },
  };
}

export function createSiteAnalytics(db: DB, client: ClientInfo) {
  const keys = hashKeys(db);
  const online = presence();
  const queue = pending();
  let prunedDay = "";

  /**
   * Hosts come from the caller (Origin, Referer, the posted referrer): at
   * most 100 new ones per day and column, others count as "other", so
   * nobody can grow the database by inventing hosts.
   */
  const hostsSeen = new Map<string, { day: string; hosts: Set<string> }>();
  function capped(column: "source" | "origin", date: string, host: string): string {
    if (host === "direct" || host === "none") return host;
    let seen = hostsSeen.get(column);
    if (seen?.day !== date) {
      const table = column === "source" ? "site_analytics_pageviews" : "site_analytics_api_calls";
      const rows = db.prepare(`SELECT DISTINCT ${column} AS host FROM ${table} WHERE day = ?`).all(date) as { host: string }[];
      hostsSeen.set(column, (seen = { day: date, hosts: new Set(rows.map((row) => row.host)) }));
    }
    if (seen.hosts.has(host)) return host;
    if (seen.hosts.size >= MAX_HOSTS_PER_DAY) return "other";
    seen.hosts.add(host);
    return host;
  }

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
    const limited = db.prepare(`INSERT INTO site_analytics_rate_limited(day, scope, hits) VALUES (?, ?, ?)
      ON CONFLICT(day, scope) DO UPDATE SET hits = hits + excluded.hits`);
    for (const [k, n] of queue.counts.limited) limited.run(...k.split("\0"), n);
    const limitedClient = db.prepare("INSERT OR IGNORE INTO site_analytics_rate_limited_clients(day, client_hash) VALUES (?, ?)");
    for (const k of queue.sets.limitedClients) limitedClient.run(...k.split("\0"));
    queue.clear();
    // Retention: once a day is enough.
    const today = day();
    if (prunedDay === today) return;
    prunedDay = today;
    const cutoff = isoDay(Date.now() - RETENTION_DAYS * 86400000);
    for (const table of ["site_analytics_pageviews", "site_analytics_visitors", "site_analytics_signups", "site_analytics_api_calls", "site_analytics_api_clients", "site_analytics_rate_limited", "site_analytics_rate_limited_clients"]) {
      db.prepare(`DELETE FROM ${table} WHERE day < ?`).run(cutoff);
    }
    db.prepare("DELETE FROM site_analytics_known_visitors WHERE last_day < ?").run(isoDay(Date.now() - KNOWN_VISITOR_DAYS * 86400000));
  });
  /** Writes what is pending (every minute, before the admin reads, and at shutdown). */
  function flush(): void {
    if (!db.open) return;
    if (queue.empty() && prunedDay === day()) return;
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
    return typeof body.page === "string" && PAGES.has(body.page)
      ? { page: body.page, visitor: body.visitor, referrer: body.referrer, via: body.via } : null;
  }

  const routes = new Hono()
    .post("/view", async (c) => {
      const body = await pageBody(c);
      if (!body) return c.json({ error: "invalid page" }, 400);
      const date = day();
      const visitor = visitorOf(c, date, body.visitor);
      const source = sourceOf(body.referrer, body.via, siteHostOf(c));
      const [kind, host] = source.startsWith("sign-in:") ? ["sign-in:", source.slice(8)] : ["", source];
      queue.add(queue.counts.pageviews, date, body.page, kind + capped("source", date, host));
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
   * server or script; capped per day) and client kind, plus distinct client
   * addresses per day. Cached answers count; refused ones (429) count only
   * as rate limited (trackLimited), so a flood adds no rows.
   */
  const trackApi: MiddlewareHandler = async (c, next) => {
    await next();
    if (c.req.method !== "GET" || c.res.status === 429) return;
    const fetchSite = c.req.header("sec-fetch-site");
    const siteHost = siteHostOf(c);
    const from = hostOf(c.req.header("origin")) ?? hostOf(c.req.header("referer"));
    if (fetchSite === "same-origin" || (!fetchSite && from === siteHost)) return;
    const date = day();
    const origin = from && from !== siteHost ? capped("origin", date, from) : "none";
    queue.add(queue.counts.api, date, routeOf(c.req.path), origin, clientKind(c.req.header("user-agent") ?? ""));
    queue.put(queue.sets.apiClients, date, hmac(keys.daily(date), "api", client.clientId(c)));
  };

  /** Every request the server refuses with 429 (any limiter), by scope, and distinct client addresses per day. */
  const trackLimited: MiddlewareHandler = async (c, next) => {
    await next();
    if (c.res.status !== 429) return;
    const date = day();
    queue.add(queue.counts.limited, date, limitedScope(c.req.path));
    queue.put(queue.sets.limitedClients, date, hmac(keys.daily(date), "limited", client.clientId(c)));
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
    const limitedHits = byDay("SELECT day, SUM(hits) AS n FROM site_analytics_rate_limited WHERE day >= ? GROUP BY day");
    const limitedClients = byDay("SELECT day, COUNT(*) AS n FROM site_analytics_rate_limited_clients WHERE day >= ? GROUP BY day");
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
        WHERE day >= ? AND source != 'direct' AND source NOT LIKE 'sign-in:%' GROUP BY source ORDER BY views DESC, source LIMIT 20`),
      sign_ins: top(`SELECT substr(source, 9) AS provider, SUM(views) AS views FROM site_analytics_pageviews
        WHERE day >= ? AND source LIKE 'sign-in:%' GROUP BY source ORDER BY views DESC, source`),
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
      rate_limited: {
        days: dense((d) => ({ hits: limitedHits.get(d) ?? 0, clients: limitedClients.get(d) ?? 0 })) as SiteAnalyticsOverview["rate_limited"]["days"],
        scopes: top(`SELECT scope, SUM(hits) AS hits FROM site_analytics_rate_limited
          WHERE day >= ? GROUP BY scope ORDER BY hits DESC, scope`),
      },
    };
  }

  return { routes, trackApi, trackLimited, overview, flush };
}

export type SiteAnalytics = ReturnType<typeof createSiteAnalytics>;
