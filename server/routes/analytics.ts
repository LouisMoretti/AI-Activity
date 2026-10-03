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
/** Distinct entries held in memory at once (pending writes); beyond it, new ones are dropped. */
const MAX_TRACKED = 10_000;
/** Visitors held in the online view at once (each minute too); beyond it, new ones are not shown. */
const MAX_ONLINE = 2_000;
/**
 * Visitors, and distinct API or rate-limited clients, recorded per UTC day
 * each: anyone can invent ids and addresses, so this bounds the rows a
 * flood can add (beyond it, page views and calls still count).
 */
const MAX_CLIENTS_PER_DAY = 2_000;
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
 * Hash keys. Browser ids are random (128 bits), so their HMAC under the
 * permanent key, stored in `settings`, cannot be reversed even from a
 * backup, and a restart counts nobody twice. Addresses can be enumerated
 * (2^32 for IPv4): their key is rotated every UTC day and kept in memory
 * only, never in the database or its backups, so a stored hash never leads
 * back to an address. A restart starts a new one (clients without an id
 * may count twice that day).
 */
function hashKeys(db: DB) {
  const read = db.prepare("SELECT value FROM settings WHERE key = ?");
  let permanent = (read.get("analytics_key") as { value: string } | undefined)?.value;
  if (!permanent) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('analytics_key', ?)").run((permanent = randomBytes(32).toString("hex")));
  }
  let daily = { date: "", key: "" };
  return {
    permanent: permanent!,
    daily(date: string): string {
      if (daily.date !== date) daily = { date, key: randomBytes(32).toString("hex") };
      return daily.key;
    },
  };
}

/**
 * Distinct values a caller can invent (hosts, visitors, client hashes), per
 * UTC day: at most `max` are recorded, those already stored that day
 * included (`sql` lists them, reloaded when the day turns). `fits` only
 * checks; `add` takes a slot once the value was really queued, so one the
 * queue dropped can still be recorded later that day.
 */
function dailyDistinct(db: DB, sql: string, max: number) {
  let today = { date: "", values: new Set<string>() };
  const values = (date: string) => {
    if (today.date !== date) {
      today = { date, values: new Set((db.prepare(sql).all(date) as { v: string }[]).map((row) => row.v)) };
    }
    return today.values;
  };
  return {
    fits: (date: string, value: string) => values(date).has(value) || values(date).size < max,
    add: (date: string, value: string) => { values(date).add(value); },
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
      if (!seen.has(visitor) && seen.size >= MAX_ONLINE) return;
      seen.set(visitor, { at: now, page });
      const minute = Math.floor(now / 60_000);
      let set = minutes.get(minute);
      if (!set) minutes.set(minute, (set = new Set()));
      if (set.size < MAX_ONLINE) set.add(visitor);
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
    /** False when the queue is full and this key is new (dropped). */
    add(map: Map<string, number>, ...key: string[]): boolean {
      const k = key.join("\0");
      if (!map.has(k) && full()) return false;
      map.set(k, (map.get(k) ?? 0) + 1);
      return true;
    },
    put(set: Set<string>, ...key: string[]): boolean {
      const k = key.join("\0");
      if (!set.has(k) && full()) return false;
      set.add(k);
      return true;
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
  /** Flushes failed in a row; after 3, the pending counts are dropped rather than retried forever. */
  let failures = 0;

  /**
   * Hosts come from the caller (Origin, Referer, the posted referrer): at
   * most 100 per day and column, others count as "other", so nobody can
   * grow the database by inventing hosts. A sign-in return's host counts
   * once with the referrers' (stored as "sign-in:<host>").
   */
  const hostCaps = {
    source: dailyDistinct(db, `SELECT DISTINCT CASE WHEN source LIKE 'sign-in:%' THEN substr(source, 9) ELSE source END AS v
      FROM site_analytics_pageviews WHERE day = ? AND source NOT IN ('direct', 'other')`, MAX_HOSTS_PER_DAY),
    origin: dailyDistinct(db, `SELECT DISTINCT origin AS v FROM site_analytics_api_calls
      WHERE day = ? AND origin NOT IN ('none', 'other')`, MAX_HOSTS_PER_DAY),
  };
  const uncapped = (host: string) => host === "direct" || host === "none" || host === "other";
  /** The host to queue, or "other" when the day has no room left for it. */
  function capped(column: "source" | "origin", date: string, host: string): string {
    return uncapped(host) || hostCaps[column].fits(date, host) ? host : "other";
  }
  /** Queues a count keyed by a capped host, then takes the host's slot (only if it was queued). */
  function addWithHost(map: Map<string, number>, column: "source" | "origin", date: string, host: string, key: string[]): void {
    if (queue.add(map, ...key) && !uncapped(host)) hostCaps[column].add(date, host);
  }
  /** Queues a distinct value (visitor, client) if the day has room, then takes its slot. */
  function putCapped(cap: ReturnType<typeof dailyDistinct>, set: Set<string>, date: string, value: string, ...rest: string[]): void {
    if (cap.fits(date, value) && queue.put(set, date, value, ...rest)) cap.add(date, value);
  }
  const clientCaps = {
    visitors: dailyDistinct(db, "SELECT visitor_hash AS v FROM site_analytics_visitors WHERE day = ?", MAX_CLIENTS_PER_DAY),
    api: dailyDistinct(db, "SELECT client_hash AS v FROM site_analytics_api_clients WHERE day = ?", MAX_CLIENTS_PER_DAY),
    limited: dailyDistinct(db, "SELECT client_hash AS v FROM site_analytics_rate_limited_clients WHERE day = ?", MAX_CLIENTS_PER_DAY),
  };

  const write = db.transaction((today: string, prune: boolean) => {
    const view = db.prepare(`INSERT INTO site_analytics_pageviews(day, page, source, views) VALUES (?, ?, ?, ?)
      ON CONFLICT(day, page, source) DO UPDATE SET views = views + excluded.views`);
    for (const [k, n] of queue.counts.pageviews) view.run(...k.split("\0"), n);
    const visitor = db.prepare("INSERT OR IGNORE INTO site_analytics_visitors(day, visitor_hash, returning_visitor) VALUES (?, ?, ?)");
    const firstDay = db.prepare("SELECT first_day FROM site_analytics_known_visitors WHERE visitor_hash = ?").pluck();
    const known = db.prepare(`INSERT INTO site_analytics_known_visitors(visitor_hash, first_day, last_day) VALUES (?, ?, ?)
      ON CONFLICT(visitor_hash) DO UPDATE SET first_day = min(first_day, excluded.first_day), last_day = max(last_day, excluded.last_day)`);
    for (const k of queue.sets.visitors) {
      const [date, hash, id] = k.split("\0");
      if (!id) { visitor.run(date, hash, null); continue; }
      const first = firstDay.get(id) as string | undefined;
      visitor.run(date, hash, first !== undefined && first < date ? 1 : 0);
      known.run(id, date, date);
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
    // Retention: once a day is enough.
    if (!prune) return;
    const cutoff = isoDay(Date.now() - RETENTION_DAYS * 86400000);
    for (const table of ["site_analytics_pageviews", "site_analytics_visitors", "site_analytics_signups", "site_analytics_api_calls", "site_analytics_api_clients", "site_analytics_rate_limited", "site_analytics_rate_limited_clients"]) {
      db.prepare(`DELETE FROM ${table} WHERE day < ?`).run(cutoff);
    }
    db.prepare("DELETE FROM site_analytics_known_visitors WHERE last_day < ?").run(isoDay(Date.now() - KNOWN_VISITOR_DAYS * 86400000));
  });
  /** Writes what is pending (every minute, before the admin reads, and at shutdown). */
  function flush(): void {
    if (!db.open) return;
    const today = day();
    if (queue.empty() && prunedDay === today) return;
    try {
      write(today, prunedDay !== today);
      // Only once committed: a failed write keeps its counts for the next flush.
      queue.clear();
      prunedDay = today;
      failures = 0;
    } catch (err) {
      console.error("site analytics flush failed:", err);
      if (++failures >= 3) {
        console.error("site analytics: dropping pending counts after 3 failed flushes");
        queue.clear();
        failures = 0;
      }
    }
  }
  setInterval(flush, FLUSH_MS).unref();

  /**
   * A visitor, for one day: from the browser's id when it sent one ("v:",
   * keyed by the day too, so days cannot be linked; `id` is its day-free
   * hash for first and last seen), else its address and user agent under
   * the day's key ("d:").
   */
  function visitorOf(c: Context, date: string, token: unknown): { hash: string; id: string } {
    if (typeof token === "string" && VISITOR_TOKEN.test(token)) {
      return { hash: `v:${hmac(keys.permanent, "visitor-day", date, token)}`, id: `v:${hmac(keys.permanent, "visitor", token)}` };
    }
    return { hash: `d:${hmac(keys.daily(date), "visitor", client.clientId(c), c.req.header("user-agent") ?? "")}`, id: "" };
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
      const kept = capped("source", date, host);
      addWithHost(queue.counts.pageviews, "source", date, kept, [date, body.page, kind + kept]);
      putCapped(clientCaps.visitors, queue.sets.visitors, date, visitor.hash, visitor.id);
      online.touch(visitor.hash, body.page);
      return c.body(null, 204);
    })
    // Heartbeat of a visible tab: memory only.
    .post("/ping", async (c) => {
      const body = await pageBody(c);
      if (!body) return c.json({ error: "invalid page" }, 400);
      online.touch(visitorOf(c, day(), body.visitor).hash, body.page);
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
    const kind = clientKind(c.req.header("user-agent") ?? "");
    if (fetchSite === "same-origin") return;
    // Browsers without Sec-Fetch-Site (Safari before 16.4): this site's own
    // fetches carry no Origin (same-origin GET) and no Referer (no-referrer),
    // while another site's always carry an Origin (CORS).
    if (!fetchSite && (from === siteHost || (!from && kind === "browser"))) return;
    const date = day();
    const origin = from && from !== siteHost ? capped("origin", date, from) : "none";
    addWithHost(queue.counts.api, "origin", date, origin, [date, routeOf(c.req.path), origin, kind]);
    putCapped(clientCaps.api, queue.sets.apiClients, date, hmac(keys.daily(date), "api", client.clientId(c)));
  };

  /** Every request the server refuses with 429 (any limiter), by scope, and distinct client addresses per day. */
  const trackLimited: MiddlewareHandler = async (c, next) => {
    await next();
    if (c.res.status !== 429) return;
    const date = day();
    queue.add(queue.counts.limited, date, limitedScope(c.req.path));
    putCapped(clientCaps.limited, queue.sets.limitedClients, date, hmac(keys.daily(date), "limited", client.clientId(c)));
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
    const newVisitors = byDay("SELECT day, COUNT(*) AS n FROM site_analytics_visitors WHERE day >= ? AND returning_visitor = 0 GROUP BY day");
    const returning = byDay("SELECT day, COUNT(*) AS n FROM site_analytics_visitors WHERE day >= ? AND returning_visitor = 1 GROUP BY day");
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
      // Browsers with an id once each (last seen in the window), the others once per day.
      unique_visitors: (db.prepare(`SELECT (SELECT COUNT(*) FROM site_analytics_known_visitors WHERE last_day >= ?)
        + (SELECT COUNT(*) FROM site_analytics_visitors WHERE day >= ? AND returning_visitor IS NULL) AS n`).get(since, since) as { n: number }).n,
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
