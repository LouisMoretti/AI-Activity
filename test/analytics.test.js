import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { asNewClient, req, startServer } from "./helpers.js";

test("site analytics are on by default and aggregate generic routes, referrer hosts, visitors and sign-ups", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  assert.equal((await req(srv.base, "GET", "/api/admin/analytics", { anon: true })).status, 401);
  const headers = { "user-agent": "test-browser", "x-forwarded-for": "198.51.100.7" };
  for (let i = 0; i < 2; i++) {
    const posted = await req(srv.base, "POST", "/api/analytics/view", {
      anon: true, headers, body: { page: "profile", referrer: "https://www.search.example/some/profile/name" },
    });
    assert.equal(posted.status, 204);
  }
  // The web client sends only the referrer's host name.
  assert.equal((await req(srv.base, "POST", "/api/analytics/view", {
    anon: true, headers, body: { page: "leaderboard", referrer: "news.example" },
  })).status, 204);
  const overview = (await req(srv.base, "GET", "/api/admin/analytics")).json;
  assert.deepEqual(overview.pages, [{ page: "profile", views: 2 }, { page: "leaderboard", views: 1 }]);
  assert.deepEqual(overview.sources, [{ source: "search.example", views: 2 }, { source: "news.example", views: 1 }]);
  assert.equal(overview.days.length, 30, "every day of the window, zeros included");
  const today = overview.days.at(-1);
  assert.equal(today.day, new Date().toISOString().slice(0, 10));
  assert.equal(today.pageviews, 3);
  assert.equal(today.visitors, 1);
  assert.equal(today.signups, 1); // the setup account
  assert.equal(overview.days.slice(0, -1).every((d) => d.pageviews === 0 && d.visitors === 0), true);
  assert.equal(JSON.stringify(overview).includes("name"), false);
});

test("site analytics counts who is online from views and heartbeats, without touching the database", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const online = async () => (await req(srv.base, "GET", "/api/admin/analytics")).json.online;
  assert.deepEqual(await online(), { now: 0, pages: [], minutes: Array(60).fill(0) });

  const a = { "user-agent": "browser-a", "x-forwarded-for": "198.51.100.1" };
  const b = { "user-agent": "browser-b", "x-forwarded-for": "198.51.100.2" };
  await req(srv.base, "POST", "/api/analytics/view", { anon: true, headers: a, body: { page: "leaderboard" } });
  assert.equal((await req(srv.base, "POST", "/api/analytics/ping", { anon: true, headers: b, body: { page: "profile" } })).status, 204);
  assert.equal((await req(srv.base, "POST", "/api/analytics/ping", { anon: true, headers: a, body: { page: "profile" } })).status, 204);
  const now = await online();
  assert.equal(now.now, 2);
  assert.deepEqual(now.pages, [{ page: "profile", visitors: 2 }]); // a moved on to a profile
  assert.equal(now.minutes.length, 60);
  assert.equal(Math.max(...now.minutes.slice(-2)), 2); // a minute may turn between the posts

  // A heartbeat records no page view.
  const days = (await req(srv.base, "GET", "/api/admin/analytics")).json.days;
  assert.equal(days.at(-1).pageviews, 1);
  assert.equal((await req(srv.base, "POST", "/api/analytics/ping", { anon: true, body: { page: "nope" } })).status, 400);
});

test("site analytics accepts only known page categories", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  assert.equal((await req(srv.base, "POST", "/api/analytics/view", { anon: true, body: { page: "/u/private-login" } })).status, 400);
});

const analytics = async (base) => (await req(base, "GET", "/api/admin/analytics")).json;
const view = (base, body, headers = {}) => req(base, "POST", "/api/analytics/view", { anon: true, headers, body });
const ID = "0123456789abcdef0123456789abcdef";
function withDb(srv, fn) {
  const db = new Database(srv.dbPath, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}

test("a browser's id counts it once across addresses, and tells new from returning visitors", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  // Same id, another user agent (a different address would hash alike): one visitor.
  assert.equal((await view(srv.base, { page: "profile", visitor: ID }, { "user-agent": "phone" })).status, 204);
  await view(srv.base, { page: "leaderboard", visitor: ID }, { "user-agent": "phone, after an update" });
  let today = (await analytics(srv.base)).days.at(-1);
  assert.deepEqual([today.visitors, today.new_visitors, today.returning_visitors], [1, 1, 0]);

  // Only HMACs are stored, and the day's visitor hash is not the id's: rows of
  // different days cannot be linked to each other or to first/last seen.
  const db = new Database(srv.dbPath);
  const known = db.prepare("SELECT visitor_hash FROM site_analytics_known_visitors").all();
  const visits = db.prepare("SELECT visitor_hash FROM site_analytics_visitors").all();
  assert.equal(known.length, 1);
  assert.equal(visits.length, 1);
  assert.ok(!known[0].visitor_hash.includes(ID));
  assert.notEqual(visits[0].visitor_hash, known[0].visitor_hash);
  // Seen on an earlier day: returning (decided when today's visit is written).
  db.prepare("UPDATE site_analytics_known_visitors SET first_day = '2000-01-01'").run();
  db.prepare("DELETE FROM site_analytics_visitors").run();
  db.close();
  await view(srv.base, { page: "profile", visitor: ID });
  today = (await analytics(srv.base)).days.at(-1);
  assert.deepEqual([today.visitors, today.new_visitors, today.returning_visitors], [1, 0, 1]);

  // A malformed id falls back to the address and user agent (another visitor, never "new").
  await view(srv.base, { page: "profile", visitor: "not-an-id" }, { "user-agent": "desktop" });
  const overview = await analytics(srv.base);
  assert.deepEqual([overview.days.at(-1).visitors, overview.days.at(-1).new_visitors, overview.unique_visitors], [2, 0, 2]);
});

test("a restart keeps pending counts and browser ids, never the address key", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-analytics-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { DB_PATH: path.join(dir, "t.db") };
  const first = await startServer({ env });
  await view(first.base, { page: "profile", visitor: ID });
  await view(first.base, { page: "profile" }, { "user-agent": "no-storage" });
  await req(first.base, "GET", "/api/profiles", { anon: true, headers: { "user-agent": "curl/8" } });
  await first.stop(); // SIGTERM writes what was pending
  // The day's address key lives in memory only: no backup can map a stored hash back to an address.
  const settings = new Database(env.DB_PATH, { readonly: true });
  assert.deepEqual(settings.prepare("SELECT key FROM settings WHERE key LIKE 'analytics%'").pluck().all(), ["analytics_key"]);
  settings.close();
  const second = await startServer({ env });
  t.after(() => second.stop());
  await view(second.base, { page: "profile", visitor: ID });
  await view(second.base, { page: "profile" }, { "user-agent": "no-storage" });
  const today = (await analytics(second.base)).days.at(-1);
  // The id counts once; the browser without one twice (a new address key after the restart).
  assert.deepEqual([today.pageviews, today.visitors, today.new_visitors], [4, 3, 1]);
});

test("external reads of the public API are counted by route, origin and client, never this site's own", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const get = (p, headers) => req(srv.base, "GET", p, { anon: true, headers });
  await get("/api/leaderboard?days=7", { "user-agent": "curl/8.7.1" });
  await get("/api/u/admin/summary", { "user-agent": "node", origin: "https://blog.example" });
  await get("/api/u/admin", { "user-agent": "Mozilla/5.0", referer: "https://www.stats.example/me" });
  await get("/api/profiles", { "user-agent": "python-requests/2.32" });
  // This site's pages: same-origin fetches, not counted.
  await get("/api/leaderboard", { "user-agent": "Mozilla/5.0", "sec-fetch-site": "same-origin" });
  const { api } = await analytics(srv.base);
  assert.equal(api.days.length, 30);
  assert.deepEqual([api.days.at(-1).calls, api.days.at(-1).clients], [4, 1]); // clients: one address here
  assert.deepEqual(api.routes, [
    { route: "leaderboard", calls: 1 }, { route: "profile", calls: 1 },
    { route: "profile.summary", calls: 1 }, { route: "profiles", calls: 1 },
  ]);
  assert.deepEqual(api.origins, [
    { origin: "none", calls: 2 }, { origin: "blog.example", calls: 1 }, { origin: "stats.example", calls: 1 },
  ]);
  assert.deepEqual(api.clients.map((c) => c.client).sort(), ["browser", "curl", "node", "python"]);
  assert.equal(JSON.stringify(api).includes("admin"), false, "no profile names");
});

test("sign-in returns keep their provider's host, apart from referrers", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  await view(srv.base, { page: "profile", referrer: "github.com", via: "sign-in" });
  await view(srv.base, { page: "profile", referrer: "github.com" }); // a link on GitHub
  await view(srv.base, { page: "settings", via: "sign-in" });
  const overview = await analytics(srv.base);
  assert.deepEqual(overview.sign_ins, [{ provider: "github.com", views: 1 }, { provider: "unknown", views: 1 }]);
  assert.deepEqual(overview.sources, [{ source: "github.com", views: 1 }]);
});

test("refused requests are counted by limit, never as API reads, and caller-made hosts are capped", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  // 101 invented origins: 100 kept, the rest is "other".
  for (let i = 0; i < 101; i++) {
    await req(srv.base, "GET", "/api/profiles", { anon: true, headers: { origin: `https://site-${i}.example` } });
  }
  let { api } = await analytics(srv.base);
  assert.equal(api.origins.length, 20, "the top 20 only");
  assert.equal(api.days.at(-1).calls, 101);
  withDb(srv, (db) => {
    assert.equal(db.prepare("SELECT COUNT(DISTINCT origin) AS n FROM site_analytics_api_calls").get().n, 101);
    assert.equal(db.prepare("SELECT calls FROM site_analytics_api_calls WHERE origin = 'other'").get().calls, 1);
  });

  // Past the public read limit (300 per client): refused requests count only as rate limited.
  const results = await Promise.all(Array.from({ length: 400 }, () =>
    req(srv.base, "GET", "/api/profiles", { anon: true, headers: { origin: "https://flood.example" } })));
  const refused = results.filter((r) => r.status === 429).length;
  assert.ok(refused > 0);
  const overview = await analytics(srv.base);
  api = overview.api;
  assert.equal(api.days.at(-1).calls, 101 + 400 - refused);
  const scope = overview.rate_limited.scopes.find((s) => s.scope === "public.profiles");
  assert.equal(scope.hits, refused);
  assert.deepEqual([overview.rate_limited.days.at(-1).hits, overview.rate_limited.days.at(-1).clients], [refused, 1]);
});

test("invented visitors and clients add at most 2,000 rows per day each", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const id = (i) => i.toString(16).padStart(32, "0");
  for (let i = 0; i < 2010; i += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 2010 - i) }, (_, j) =>
      view(srv.base, { page: "profile", visitor: id(i + j) }, asNewClient())));
  }
  const overview = await analytics(srv.base);
  assert.equal(overview.days.at(-1).pageviews, 2010, "views still count");
  assert.equal(overview.days.at(-1).visitors, 2000);
  withDb(srv, (db) => {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM site_analytics_known_visitors").get().n, 2000);
  });
  assert.ok(overview.online.now <= 2000);
});

test("analytics posts have their own, stricter limit", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const client = asNewClient();
  const results = await Promise.all(Array.from({ length: 80 }, () =>
    req(srv.base, "POST", "/api/analytics/ping", { anon: true, headers: client, body: { page: "profile" } })));
  assert.equal(results.filter((r) => r.status === 204).length, 60);
  assert.ok(results.some((r) => r.status === 429));
});

test("after a restart, the host cap counts each host once and ignores direct visits", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-analytics-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { DB_PATH: path.join(dir, "t.db") };
  const first = await startServer({ env });
  await view(first.base, { page: "profile" }, asNewClient());
  await view(first.base, { page: "profile", referrer: "github.com", via: "sign-in" }, asNewClient());
  await view(first.base, { page: "profile", referrer: "github.com" }, asNewClient());
  for (let i = 0; i < 98; i++) await view(first.base, { page: "profile", referrer: `site-${i}.example` }, asNewClient());
  await first.stop();
  const second = await startServer({ env });
  t.after(() => second.stop());
  // 99 hosts so far: one more fits, the next is "other".
  await view(second.base, { page: "profile", referrer: "last.example" }, asNewClient());
  await view(second.base, { page: "profile", referrer: "over.example" }, asNewClient());
  await analytics(second.base);
  withDb(second, (db) => {
    const sources = db.prepare("SELECT source FROM site_analytics_pageviews").pluck().all();
    assert.ok(sources.includes("last.example"));
    assert.ok(!sources.includes("over.example"));
    assert.ok(sources.includes("other"));
  });
});

test("a browser without Sec-Fetch-Site: this site's own reads are not API reads, another site's are", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const ua = { "user-agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15" };
  await req(srv.base, "GET", "/api/leaderboard", { anon: true, headers: ua }); // own page: no Origin, no Referer
  await req(srv.base, "GET", "/api/leaderboard", { anon: true, headers: { ...ua, origin: "https://other.example" } });
  await req(srv.base, "GET", "/api/leaderboard", { anon: true, headers: { "user-agent": "curl/8" } });
  const { api } = await analytics(srv.base);
  assert.deepEqual(api.origins, [{ origin: "none", calls: 1 }, { origin: "other.example", calls: 1 }]);
});

test("a failed write keeps its counts for the next flush", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const db = new Database(srv.dbPath);
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER fail BEFORE INSERT ON site_analytics_pageviews BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  await view(srv.base, { page: "profile", visitor: ID });
  assert.equal((await req(srv.base, "GET", "/api/admin/analytics")).status, 200); // the flush fails, logged
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM site_analytics_visitors").get().n, 0, "rolled back");
  db.exec("DROP TRIGGER fail");
  const today = (await analytics(srv.base)).days.at(-1);
  assert.deepEqual([today.pageviews, today.visitors], [1, 1]);
});
