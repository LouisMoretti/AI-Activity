import test from "node:test";
import assert from "node:assert/strict";
import { req, startServer } from "./helpers.js";

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
