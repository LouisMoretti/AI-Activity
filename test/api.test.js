import fs from "node:fs";
import os from "node:os";
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
    // Idempotent: SQLite counts matched rows even when the value is unchanged.
    assert.equal((await req(srv.base, "POST", `/api/devices/${d.id}/revoke`)).status, 200);
    assert.equal((await req(srv.base, "POST", "/api/devices/999999/revoke")).status, 404);
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

  test("a replayed stale snapshot does not replace a newer quota", async () => {
    const now = Math.floor(Date.now() / 1000);
    const q = (pct) => ({ five_hour: { used_percentage: pct, resets_at: now + 3600 } });
    await req(srv.base, "POST", "/api/ingest", { key, body: event({ account_ref: "replay", rate_limits: q(60), occurred_at: now }) });
    await req(srv.base, "POST", "/api/ingest", { key, body: event({ account_ref: "replay", rate_limits: q(10), occurred_at: now - 7200 }) });
    const quotas = (await req(srv.base, "GET", "/api/quotas")).json.quotas.filter((x) => x.account_ref === "replay");
    assert.equal(quotas.length, 1);
    assert.equal(quotas[0].used_pct, 60);
  });

  test("an unchanged quota value refreshes its measured_at", async () => {
    const now = Math.floor(Date.now() / 1000);
    const q = { seven_day: { used_percentage: 12, resets_at: now + 86400 } };
    await req(srv.base, "POST", "/api/ingest", { key, body: event({ account_ref: "same", rate_limits: q, occurred_at: now - 60 }) });
    await req(srv.base, "POST", "/api/ingest", { key, body: event({ account_ref: "same", rate_limits: q, occurred_at: now }) });
    await req(srv.base, "POST", "/api/ingest", { key, body: event({ account_ref: "same", rate_limits: q, occurred_at: now - 30 }) });
    const rows = (await req(srv.base, "GET", "/api/quotas")).json.quotas.filter((x) => x.account_ref === "same");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].used_pct, 12);
    assert.equal(rows[0].measured_at, now);
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

  test("occurred_at in the future is clamped to the receive time", async () => {
    const now = Math.floor(Date.now() / 1000);
    await req(srv.base, "POST", "/api/ingest", { key, body: event({ session_id: "future", occurred_at: now + 400 * 86400 }) });
    const s = (await req(srv.base, "GET", "/api/sessions?limit=200")).json.sessions.find((x) => x.session_id === "future");
    assert.ok(s.last_seen <= Math.floor(Date.now() / 1000));
    assert.ok(s.last_seen >= now);
  });

  test("a session reports its latest model, not the largest name", async () => {
    const now = Math.floor(Date.now() / 1000);
    await req(srv.base, "POST", "/api/ingest", { key, body: event({ session_id: "switch", model: "claude-sonnet-5", occurred_at: now - 60 }) });
    await req(srv.base, "POST", "/api/ingest", { key, body: event({ session_id: "switch", model: "claude-opus-5-5", occurred_at: now }) });
    await req(srv.base, "POST", "/api/ingest", { key, body: event({ session_id: "switch", model: "claude-haiku-4-5", occurred_at: now - 30 }) });
    const s = (await req(srv.base, "GET", "/api/sessions?limit=200")).json.sessions.find((x) => x.session_id === "switch");
    assert.equal(s.model, "claude-opus-5-5");
  });

  test("sessions page with offset past the per-request cap", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 5; i++) {
      await req(srv.base, "POST", "/api/ingest", { key, body: event({ session_id: `page-${i}`, occurred_at: now + i }) });
    }
    const all = (await req(srv.base, "GET", "/api/sessions?limit=200")).json;
    const p1 = (await req(srv.base, "GET", "/api/sessions?limit=2")).json.sessions;
    const p2 = (await req(srv.base, "GET", "/api/sessions?limit=2&offset=2")).json.sessions;
    assert.deepEqual([...p1, ...p2].map((s) => s.session_id), all.sessions.slice(0, 4).map((s) => s.session_id));
    const past = (await req(srv.base, "GET", `/api/sessions?limit=5&offset=${all.total}`)).json;
    assert.deepEqual(past.sessions, []);
    assert.equal(past.total, all.total);
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

  test("billing: invalid subscriptions are rejected", async () => {
    const post = (over) => req(srv.base, "POST", "/api/billing/subscription", {
      body: { tool: "claude-code", plan_name: "Pro", amount: 20, ...over },
    });
    assert.equal((await post({ amount: -5 })).status, 400);
    assert.equal((await post({ amount: "" })).status, 400);
    for (const amount of [null, true, [5]]) assert.equal((await post({ amount })).status, 400);
    assert.equal((await post({ amount: "12.5" })).status, 200);
    assert.equal((await post({ currency: "euros" })).status, 400);
    assert.equal((await post({ currency: "ABC" })).status, 400);
    assert.equal((await post({ plan_name: "   " })).status, 400);
    assert.equal((await post({ tool: 123 })).status, 400);
    assert.equal((await post({ period_start: "2026-02-30" })).status, 400);
    assert.equal((await post({ period_start: "2026-03-01", period_end: "2026-02-01" })).status, 400);
    const ok = await post({ currency: "eur", period_start: "2026-09-01", period_end: "2026-09-30" });
    assert.equal(ok.status, 200);
    const b = (await req(srv.base, "GET", "/api/billing")).json;
    assert.ok(b.subscriptions.some((s) => s.id === ok.json.id && s.currency === "EUR"));
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
    const deep = await req(srv.base, "GET", "/some/client/route");
    assert.equal(deep.status, 200);
    assert.equal(deep.text, home.text);
  });

  test("static serving never escapes the web root", async () => {
    for (const p of ["/%2e%2e/package.json", "/..%2fpackage.json", "/%2e%2e%2f.env.example"]) {
      const r = await req(srv.base, "GET", p);
      assert.doesNotMatch(r.text, /"dependencies"|DASHBOARD_PASSWORD/, p);
    }
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

  test("session cookie is Secure only over HTTPS", async () => {
    const plain = await req(srv.base, "POST", "/api/auth/login", { body: { password: "hunter2" } });
    assert.doesNotMatch(plain.headers.get("set-cookie"), /Secure/);
    const r = await fetch(srv.base + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ password: "hunter2" }),
    });
    assert.match(r.headers.get("set-cookie"), /Secure/);
  });

  test("repeated failed logins from one client are throttled", async () => {
    const attempt = (password, ip) => fetch(srv.base + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ password }),
    });
    for (let i = 0; i < 10; i++) assert.equal((await attempt("nope", "203.0.113.9")).status, 401);
    const blocked = await attempt("hunter2", "203.0.113.9");
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    assert.equal((await attempt("hunter2", "203.0.113.10")).status, 200);
  });
});

describe("summary, sessions and context (redesign APIs)", () => {
  let srv, key;
  before(async () => {
    srv = await startServer();
    key = (await newDevice(srv.base)).key;
  });
  after(() => srv.stop());

  test("summary splits all-time and today by model and tool", async () => {
    const now = Math.floor(Date.now() / 1000);
    await req(srv.base, "POST", "/api/ingest", { key, body: event({ session_id: "a", model: "claude-opus-5-5", occurred_at: now }) });
    await req(srv.base, "POST", "/api/ingest", { key, body: event({ session_id: "b", model: "claude-sonnet-5", occurred_at: now - 40 * 86400 }) });
    const s = (await req(srv.base, "GET", "/api/summary")).json;
    assert.equal(s.total.tokens, 360);
    assert.equal(s.total.sessions, 2);
    assert.equal(s.today.tokens, 180);
    assert.equal(s.today.sessions, 1);
    assert.deepEqual(s.total.by_model.map((r) => r.name).sort(), ["claude-opus-5-5", "claude-sonnet-5"]);
    assert.deepEqual(s.total.by_tool, [{ name: "claude-code", tokens: 360, sessions: 2, events: 2 }]);
    assert.equal(s.day, new Date().toISOString().slice(0, 10));
    assert.equal((await req(srv.base, "GET", "/api/summary?tool=codex")).json.total.tokens, 0);
  });

  test("sessions report the latest context fill and a total for paging", async () => {
    const at = Math.floor(Date.now() / 1000);
    await req(srv.base, "POST", "/api/ingest", { key, body: {
      session_id: "ctx", prompt_id: "c1", occurred_at: at - 10,
      context_window: { context_window_size: 200000, used_percentage: 20, current_usage: { input_tokens: 5 } },
    } });
    await req(srv.base, "POST", "/api/ingest", { key, body: {
      session_id: "ctx", prompt_id: "c2", occurred_at: at,
      context_window: { context_window_size: 200000, used_percentage: 35, current_usage: { input_tokens: 6 } },
    } });
    await req(srv.base, "POST", "/api/ingest", { key, body: { session_id: "ctx", prompt_id: "c3", occurred_at: at - 5, usage: { input_tokens: 7 } } });
    const r = (await req(srv.base, "GET", "/api/sessions?limit=1")).json;
    assert.equal(r.sessions.length, 1);
    assert.ok(r.total >= 3);
    const ctx = (await req(srv.base, "GET", "/api/sessions?limit=50")).json.sessions.find((s) => s.session_id === "ctx");
    assert.equal(ctx.context_used_pct, 35);
    assert.equal(ctx.context_window_size, 200000);
    const noCtx = (await req(srv.base, "GET", "/api/sessions?limit=50")).json.sessions.find((s) => s.session_id === "a");
    assert.equal(noCtx.context_used_pct, null);
    assert.equal((await req(srv.base, "GET", "/api/sessions?tool=codex")).json.total, 0);
  });

  test("estimate is flagged unavailable until a cost delta arrives", async () => {
    assert.equal((await req(srv.base, "GET", "/api/billing")).json.estimated_available, false);
    await req(srv.base, "POST", "/api/ingest", { key, body: event({ cost_estimated_usd_delta: 0.02 }) });
    assert.equal((await req(srv.base, "GET", "/api/billing")).json.estimated_available, true);
  });
});

describe("shutdown", () => {
  test("SIGTERM closes the server and checkpoints the SQLite WAL", async () => {
    const srv = await startServer();
    try {
      const { key } = await newDevice(srv.base);
      await req(srv.base, "POST", "/api/ingest", { key, body: event() });
      assert.ok(fs.existsSync(`${srv.dbPath}-wal`));
      assert.equal(await srv.kill(), 0);
      assert.ok(!fs.existsSync(`${srv.dbPath}-wal`));
    } finally {
      await srv.stop();
    }
  });
});

describe("web root without index.html", () => {
  test("client routes return 404 instead of a stale or broken page", async () => {
    const root = fs.mkdtempSync(`${os.tmpdir()}/ai-usage-empty-`);
    const srv = await startServer({ env: { STATIC_DIR: root } });
    try {
      assert.equal((await req(srv.base, "GET", "/some/client/route")).status, 404);
      fs.writeFileSync(`${root}/index.html`, "<!doctype html><p>built</p>");
      const r = await req(srv.base, "GET", "/some/client/route");
      assert.equal(r.status, 200);
      assert.match(r.text, /built/);
    } finally {
      await srv.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
