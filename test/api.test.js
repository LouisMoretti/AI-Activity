import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, req, newDevice, event } from "./helpers.js";

describe("open server (no viewer password)", () => {
  let srv, key;
  const stats = async () => (await req(srv.base, "GET", "/api/stats?days=730")).json;

  before(async () => {
    srv = await startServer();
    key = (await newDevice(srv.base)).key;
  });
  after(() => srv.stop());

  test("health", async () => {
    const r = await req(srv.base, "GET", "/api/health");
    assert.deepEqual(r.json, { ok: true });
  });

  test("ingest rejects missing, unknown and revoked keys", async () => {
    assert.equal((await req(srv.base, "POST", "/api/ingest", { body: event() })).status, 401);
    assert.equal((await req(srv.base, "POST", "/api/ingest", { body: event(), key: "ak_nope" })).status, 401);
    const d = await newDevice(srv.base, "to-revoke");
    assert.equal((await req(srv.base, "POST", "/api/ingest", { body: event(), key: d.key })).status, 200);
    assert.equal((await req(srv.base, "POST", `/api/devices/${d.id}/revoke`)).status, 200);
    assert.equal((await req(srv.base, "POST", "/api/ingest", { body: event(), key: d.key })).status, 401);
  });

  test("ingest rejects bad JSON, oversized bodies and unsupported tools", async () => {
    assert.equal((await req(srv.base, "POST", "/api/ingest", { raw: "{nope", key })).status, 400);
    const big = JSON.stringify({ pad: "x".repeat(300 * 1024) });
    assert.equal((await req(srv.base, "POST", "/api/ingest", { raw: big, key })).status, 413);
    assert.equal((await req(srv.base, "POST", "/api/ingest", { body: event({ tool: "codex" }), key })).status, 400);
  });

  test("measured event shows up in stats, activity and sessions", async () => {
    const before = await stats();
    const ev = event({ session_id: "sess-A", cost_estimated_usd_delta: 0.5 });
    const r = await req(srv.base, "POST", "/api/ingest", { body: ev, key });
    assert.equal(r.json.stored, true);
    assert.equal(r.json.deduped, false);
    const after = await stats();
    assert.equal(after.total_tokens - before.total_tokens, 180);
    assert.equal(after.events - before.events, 1);
    assert.ok(Math.abs(after.estimated_usd - before.estimated_usd - 0.5) < 1e-9);
    assert.equal(after.has_data, true);
    const sessions = (await req(srv.base, "GET", "/api/sessions?limit=50")).json.sessions;
    assert.ok(sessions.some((s) => s.session_id === "sess-A" && s.tokens === 180));
  });

  test("replaying the same event_id is deduped, totals unchanged", async () => {
    const ev = event();
    await req(srv.base, "POST", "/api/ingest", { body: ev, key });
    const mid = await stats();
    const r = await req(srv.base, "POST", "/api/ingest", { body: ev, key });
    assert.equal(r.json.deduped, true);
    assert.deepEqual(await stats(), mid);
  });

  test("identical snapshot for same prompt is deduped; distinct snapshots are kept", async () => {
    const base = event({ prompt_id: "prompt-multi" });
    await req(srv.base, "POST", "/api/ingest", { body: base, key });
    const mid = await stats();
    const dup = await req(srv.base, "POST", "/api/ingest", { body: { ...base, event_id: "other-id-1" }, key });
    assert.equal(dup.json.deduped, true);
    const next = await req(srv.base, "POST", "/api/ingest", {
      body: { ...base, event_id: "other-id-2", usage: { input_tokens: 7, output_tokens: 3 } }, key,
    });
    assert.equal(next.json.stored, true);
    assert.equal((await stats()).total_tokens - mid.total_tokens, 10);
  });

  test("empty snapshot stores no usage row but records quotas", async () => {
    const before = await stats();
    const r = await req(srv.base, "POST", "/api/ingest", {
      key,
      body: event({ usage: {}, account_ref: "empty-acct", rate_limits: { five_hour: { used_percentage: 12, resets_at: 1999999999 } } }),
    });
    assert.equal(r.json.stored, false);
    assert.equal((await stats()).events, before.events);
    const q = (await req(srv.base, "GET", "/api/quotas")).json.quotas;
    assert.ok(q.some((x) => x.account_ref === "empty-acct" && x.used_pct === 12));
  });

  test("raw statusLine shape accepted; cumulative total_cost_usd ignored", async () => {
    const before = await stats();
    const r = await req(srv.base, "POST", "/api/ingest", {
      key,
      body: {
        session_id: "raw-sess", prompt_id: "raw-p",
        model: { id: "claude-sonnet-5", display_name: "Sonnet" },
        context_window: { current_usage: { input_tokens: 1000, output_tokens: 1 } },
        cost: { total_cost_usd: 99 },
      },
    });
    assert.equal(r.json.stored, true);
    const after = await stats();
    assert.equal(after.total_tokens - before.total_tokens, 1001);
    assert.equal(after.estimated_usd, before.estimated_usd);
  });

  test("two devices on the same account: latest quota snapshot wins, never summed", async () => {
    const other = (await newDevice(srv.base, "second")).key;
    const rl = (pct) => ({ five_hour: { used_percentage: pct, resets_at: 1999999999 } });
    await req(srv.base, "POST", "/api/ingest", { key, body: event({ account_ref: "shared", rate_limits: rl(30) }) });
    await new Promise((r) => setTimeout(r, 1100)); // measured_at has 1 s resolution
    await req(srv.base, "POST", "/api/ingest", { key: other, body: event({ account_ref: "shared", rate_limits: rl(45) }) });
    const rows = (await req(srv.base, "GET", "/api/quotas")).json.quotas
      .filter((q) => q.account_ref === "shared" && q.limit_type === "five_hour");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].used_pct, 45);
  });

  test("snapshots within the same second still yield one row per window", async () => {
    const rl = (pct) => ({ seven_day: { used_percentage: pct } });
    await req(srv.base, "POST", "/api/ingest", { key, body: event({ account_ref: "fast", rate_limits: rl(10) }) });
    await req(srv.base, "POST", "/api/ingest", { key, body: event({ account_ref: "fast", rate_limits: rl(11) }) });
    const rows = (await req(srv.base, "GET", "/api/quotas")).json.quotas.filter((q) => q.account_ref === "fast");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].used_pct, 11);
  });

  test("payload without rate_limits creates no quota rows", async () => {
    const before = (await req(srv.base, "GET", "/api/quotas")).json.quotas.length;
    await req(srv.base, "POST", "/api/ingest", { key, body: event({ account_ref: "no-limits" }) });
    const q = (await req(srv.base, "GET", "/api/quotas")).json.quotas;
    assert.equal(q.length, before);
    assert.ok(!q.some((x) => x.account_ref === "no-limits"));
  });

  test("spooled events with old occurred_at land on their own day, ordered", async () => {
    const day = 86400;
    const now = Math.floor(Date.now() / 1000);
    await req(srv.base, "POST", "/api/ingest", { key, body: event({ occurred_at: now - 3 * day }) });
    await req(srv.base, "POST", "/api/ingest", { key, body: event({ occurred_at: (now - 10 * day) * 1000 }) }); // ms accepted
    const days = (await req(srv.base, "GET", "/api/activity?days=30")).json.days.map((d) => d.day);
    assert.deepEqual(days, [...days].sort());
    const iso = (s) => new Date(s * 1000).toISOString().slice(0, 10);
    assert.ok(days.includes(iso(now - 3 * day)));
    assert.ok(days.includes(iso(now - 10 * day)));
  });

  test("tool filter on stats", async () => {
    const r = (await req(srv.base, "GET", "/api/stats?days=30&tool=codex")).json;
    assert.equal(r.events, 0);
    assert.equal(r.has_data, false);
  });

  test("billing: subscription entry and estimate disclaimer", async () => {
    assert.equal((await req(srv.base, "POST", "/api/billing/subscription", { body: { tool: "claude-code" } })).status, 400);
    const ok = await req(srv.base, "POST", "/api/billing/subscription", {
      body: { tool: "claude-code", plan_name: "Max", amount: 90, currency: "EUR" },
    });
    assert.equal(ok.json.ok, true);
    const b = (await req(srv.base, "GET", "/api/billing")).json;
    assert.ok(b.subscriptions.some((s) => s.plan_name === "Max" && s.currency === "EUR"));
    assert.deepEqual(b.billing_records, []);
    assert.match(b.disclaimer, /neither an invoice nor a saving/);
  });

  test("device list never exposes key hashes", async () => {
    const devices = (await req(srv.base, "GET", "/api/devices")).json.devices;
    assert.ok(devices.length > 0);
    for (const d of devices) assert.equal(d.key_hash, undefined);
  });

  test("static index is served, unknown API is 404", async () => {
    const home = await req(srv.base, "GET", "/");
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type"), /text\/html/);
    assert.equal((await req(srv.base, "GET", "/api/nope")).status, 404);
  });
});

describe("locked server (viewer password)", () => {
  let srv;
  before(async () => { srv = await startServer({ password: "hunter2" }); });
  after(() => srv.stop());

  test("viewer APIs require login; ingest and health stay reachable", async () => {
    assert.equal((await req(srv.base, "GET", "/api/health")).status, 200);
    assert.equal((await req(srv.base, "GET", "/api/stats")).status, 401);
    assert.equal((await req(srv.base, "POST", "/api/devices", { body: { name: "x" } })).status, 401);
    assert.equal((await req(srv.base, "POST", "/api/ingest", { body: event(), key: "ak_nope" })).status, 401);
    const st = (await req(srv.base, "GET", "/api/auth/status")).json;
    assert.deepEqual(st, { locked: true, authenticated: false });
  });

  test("login / logout cycle", async () => {
    assert.equal((await req(srv.base, "POST", "/api/auth/login", { body: { password: "wrong" } })).status, 401);
    const ok = await req(srv.base, "POST", "/api/auth/login", { body: { password: "hunter2" } });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get("set-cookie").split(";")[0];
    assert.match(ok.headers.get("set-cookie"), /HttpOnly/);
    assert.equal((await req(srv.base, "GET", "/api/stats", { cookie })).status, 200);
    const d = await newDevice(srv.base, "locked-dev", cookie);
    assert.equal((await req(srv.base, "POST", "/api/ingest", { body: event(), key: d.key })).json.stored, true);
    await req(srv.base, "POST", "/api/auth/logout", { cookie });
    assert.equal((await req(srv.base, "GET", "/api/stats", { cookie })).status, 401);
  });
});
