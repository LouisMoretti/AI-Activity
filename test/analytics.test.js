import test from "node:test";
import assert from "node:assert/strict";
import { req, startServer } from "./helpers.js";

test("site analytics are disabled unless opted in", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  assert.equal((await req(srv.base, "GET", "/api/auth/status")).json.site_analytics, undefined);
  const posted = await req(srv.base, "POST", "/api/analytics/view", { anon: true, body: { page: "profile", referrer: "https://search.example/private" } });
  assert.equal(posted.status, 204);
  assert.deepEqual((await req(srv.base, "GET", "/api/admin/analytics")).json, { days: [], pages: [], sources: [] });
});

test("enabled analytics aggregate generic routes, referrer hosts, visitors and sign-ups", async (t) => {
  const srv = await startServer({ env: { SITE_ANALYTICS: "1" } });
  t.after(() => srv.stop());

  assert.equal((await req(srv.base, "GET", "/api/auth/status")).json.site_analytics, true);
  const headers = { "user-agent": "test-browser", "x-forwarded-for": "198.51.100.7" };
  for (let i = 0; i < 2; i++) {
    const posted = await req(srv.base, "POST", "/api/analytics/view", {
      anon: true, headers, body: { page: "profile", referrer: "https://www.search.example/some/profile/name" },
    });
    assert.equal(posted.status, 204);
  }
  const overview = (await req(srv.base, "GET", "/api/admin/analytics")).json;
  assert.deepEqual(overview.pages, [{ page: "profile", views: 2 }]);
  assert.deepEqual(overview.sources, [{ source: "search.example", views: 2 }]);
  assert.equal(overview.days.length, 1);
  assert.equal(overview.days[0].pageviews, 2);
  assert.equal(overview.days[0].visitors, 1);
  assert.equal(overview.days[0].signups, 1); // the setup account
  assert.equal(JSON.stringify(overview).includes("name"), false);
});

test("site analytics accepts only known page categories", async (t) => {
  const srv = await startServer({ env: { SITE_ANALYTICS: "1" } });
  t.after(() => srv.stop());
  assert.equal((await req(srv.base, "POST", "/api/analytics/view", { anon: true, body: { page: "/u/private-login" } })).status, 400);
});
