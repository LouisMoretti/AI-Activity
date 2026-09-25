import fs from "node:fs";
import os from "node:os";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, req, newDevice, event, userCli, login, genKey, register, userId, TEST_ADMIN } from "./helpers.js";

describe("basics (signed in as the test admin)", () => {
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
    const ev = event({ session_id: "sess-A" });
    const r = await req(srv.base, "POST", "/api/ingest", { body: ev, key });
    assert.equal(r.json.stored, true);
    assert.equal(r.json.deduped, false);
    const after = await stats();
    assert.equal(after.total_tokens - before.total_tokens, 180);
    assert.equal(after.events - before.events, 1);
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

  test("raw statusLine shape accepted; cost fields ignored", async () => {
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
    assert.equal(after.estimated_usd, undefined);
    // A cost-only snapshot is not usage.
    const costOnly = await req(srv.base, "POST", "/api/ingest", { key, body: { session_id: "raw-sess", cost_estimated_usd_delta: 0.5 } });
    assert.equal(costOnly.json.stored, false);
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

  test("cost and subscription routes are gone", async () => {
    assert.equal((await req(srv.base, "GET", "/api/billing")).status, 404);
    assert.equal((await req(srv.base, "POST", "/api/billing/subscription", { body: { tool: "claude-code" } })).status, 404);
  });

  test("tool filter on stats", async () => {
    const r = (await req(srv.base, "GET", "/api/stats?days=30&tool=codex")).json;
    assert.equal(r.events, 0);
    assert.equal(r.has_data, false);
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

describe("locked server (DASHBOARD_PASSWORD bootstraps an admin account)", () => {
  let srv;
  before(async () => { srv = await startServer({ password: "hunter2" }); });
  after(() => srv.stop());

  test("viewer APIs require login; ingest and health stay reachable", async () => {
    assert.equal((await req(srv.base, "GET", "/api/health")).status, 200);
    assert.equal((await req(srv.base, "GET", "/api/stats")).status, 401);
    assert.equal((await req(srv.base, "POST", "/api/devices", { body: { name: "x" } })).status, 401);
    assert.equal((await req(srv.base, "POST", "/api/ingest", { body: event(), key: "ak_nope" })).status, 401);
    const st = (await req(srv.base, "GET", "/api/auth/status")).json;
    assert.deepEqual(st, { authenticated: false, user: null, setup_required: false });
  });

  test("login / logout cycle", async () => {
    const bad = (body) => req(srv.base, "POST", "/api/auth/login", { body });
    assert.equal((await bad({ username: "admin", password: "wrong" })).status, 401);
    assert.equal((await bad({ password: "hunter2" })).status, 401);
    // Unknown user and wrong password are indistinguishable.
    assert.deepEqual((await bad({ username: "nobody", password: "hunter2" })).json,
      (await bad({ username: "admin", password: "nope" })).json);
    const ok = await req(srv.base, "POST", "/api/auth/login", { body: { username: "ADMIN", password: "hunter2" } });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get("set-cookie").split(";")[0];
    assert.match(ok.headers.get("set-cookie"), /HttpOnly/);
    assert.equal((await req(srv.base, "GET", "/api/stats", { cookie })).status, 200);
    const me = (await req(srv.base, "GET", "/api/auth/status", { cookie })).json;
    assert.deepEqual(me.user, { id: 1, username: "admin", display_name: "admin", is_admin: true });
    const d = await newDevice(srv.base, "locked-dev", cookie);
    assert.equal((await req(srv.base, "POST", "/api/ingest", { body: event(), key: d.key })).json.stored, true);
    await req(srv.base, "POST", "/api/auth/logout", { cookie });
    assert.equal((await req(srv.base, "GET", "/api/stats", { cookie })).status, 401);
  });

  test("session cookie is Secure only over HTTPS", async () => {
    const plain = await req(srv.base, "POST", "/api/auth/login", { body: { username: "admin", password: "hunter2" } });
    assert.doesNotMatch(plain.headers.get("set-cookie"), /Secure/);
    const r = await fetch(srv.base + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ username: "admin", password: "hunter2" }),
    });
    assert.match(r.headers.get("set-cookie"), /Secure/);
  });

  test("repeated failed logins from one client are throttled", async () => {
    const attempt = (password, ip) => fetch(srv.base + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ username: "admin", password }),
    });
    for (let i = 0; i < 10; i++) assert.equal((await attempt("nope", "203.0.113.9")).status, 401);
    const blocked = await attempt("hunter2", "203.0.113.9");
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    assert.equal((await attempt("hunter2", "203.0.113.10")).status, 200);
  });
});

describe("accounts", () => {
  test("nothing is viewable without an account; the first one claims the existing data", async () => {
    const srv = await startServer({ autoLogin: false });
    try {
      assert.deepEqual((await req(srv.base, "GET", "/api/auth/status")).json,
        { authenticated: false, user: null, setup_required: true });
      for (const p of ["/api/stats", "/api/summary", "/api/profiles", "/api/devices"]) {
        assert.equal((await req(srv.base, "GET", p)).status, 401, p);
      }
      assert.equal((await req(srv.base, "POST", "/api/devices", { body: { name: "x" } })).status, 401);
      assert.equal((await req(srv.base, "POST", "/api/auth/login", { body: { username: "x", password: "y" } })).status, 400);
      // Collectors keep working before any account exists (keys from the CLI).
      const key = await genKey(srv.dbPath, "pre-accounts");
      assert.equal((await req(srv.base, "POST", "/api/ingest", { key, body: event() })).json.stored, true);

      const add = await userCli(srv.dbPath, ["add", "louis", "--name", "Louis"], "correct horse");
      assert.equal(add.code, 0, add.out);
      const cookie = await login(srv.base, "louis", "correct horse");
      const st = (await req(srv.base, "GET", "/api/auth/status", { cookie })).json;
      assert.deepEqual(st, {
        authenticated: true, setup_required: false,
        user: { id: 1, username: "louis", display_name: "Louis", is_admin: true },
      });
      assert.equal((await req(srv.base, "GET", "/api/stats?days=730", { cookie })).json.events, 1);
      assert.equal((await req(srv.base, "POST", "/api/ingest", { key, body: event() })).json.stored, true);
    } finally {
      await srv.stop();
    }
  });

  test("CLI rejects weak passwords, bad usernames and duplicates", async () => {
    const srv = await startServer();
    try {
      assert.notEqual((await userCli(srv.dbPath, ["add", "louis"], "short")).code, 0);
      assert.notEqual((await userCli(srv.dbPath, ["add", "no spaces"], "long enough")).code, 0);
      assert.equal((await userCli(srv.dbPath, ["add", "louis"], "long enough")).code, 0);
      assert.notEqual((await userCli(srv.dbPath, ["add", "LOUIS"], "long enough")).code, 0);
    } finally {
      await srv.stop();
    }
  });

  test("each user only sees their own devices, usage and quotas", async () => {
    const srv = await startServer({ password: "admin-pass" });
    try {
      assert.equal((await userCli(srv.dbPath, ["add", "bob"], "bob-password")).code, 0);
      const admin = await login(srv.base, "admin", "admin-pass");
      const bob = await login(srv.base, "bob", "bob-password");
      const adminDev = await newDevice(srv.base, "admin-laptop", admin);
      const bobDev = await newDevice(srv.base, "bob-laptop", bob);
      await req(srv.base, "POST", "/api/ingest", { key: bobDev.key, body: event({
        session_id: "bob-s",
        rate_limits: { five_hour: { used_percentage: 42, resets_at: 1999999999 } },
      }) });

      const get = async (p, cookie) => (await req(srv.base, "GET", p, { cookie })).json;
      assert.equal((await get("/api/stats?days=730", admin)).events, 0);
      assert.equal((await get("/api/stats?days=730", bob)).events, 1);
      assert.deepEqual((await get("/api/quotas", admin)).quotas, []);
      assert.equal((await get("/api/quotas", bob)).quotas.length, 1);
      assert.equal((await get("/api/sessions", admin)).total, 0);
      assert.deepEqual((await get("/api/devices", admin)).devices.map((d) => d.name), ["admin-laptop"]);
      assert.deepEqual((await get("/api/devices", bob)).devices.map((d) => d.name), ["bob-laptop"]);
      // Revoking another user's device looks like an unknown id.
      assert.equal((await req(srv.base, "POST", `/api/devices/${bobDev.id}/revoke`, { cookie: admin })).status, 404);
      assert.equal((await req(srv.base, "POST", `/api/devices/${adminDev.id}/revoke`, { cookie: admin })).status, 200);
    } finally {
      await srv.stop();
    }
  });

  test("signing in again replaces the browser's previous session", async () => {
    const srv = await startServer({ password: "admin-pass" });
    try {
      const first = await login(srv.base, "admin", "admin-pass");
      const again = await req(srv.base, "POST", "/api/auth/login", {
        body: { username: "admin", password: "admin-pass" }, cookie: first,
      });
      assert.equal(again.status, 200);
      assert.equal((await req(srv.base, "GET", "/api/stats", { cookie: first })).status, 401);
    } finally {
      await srv.stop();
    }
  });

  test("sessions survive a server restart", async () => {
    const dir = fs.mkdtempSync(`${os.tmpdir()}/ai-usage-restart-`);
    const env = { DB_PATH: `${dir}/t.db` };
    try {
      const first = await startServer({ password: "admin-pass", env });
      const cookie = await login(first.base, "admin", "admin-pass");
      await first.stop();
      const second = await startServer({ env, autoLogin: false });
      try {
        assert.equal((await req(second.base, "GET", "/api/stats", { cookie })).status, 200);
      } finally {
        await second.stop();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("changing a password from the CLI signs that user out", async () => {
    const srv = await startServer({ password: "admin-pass" });
    try {
      const cookie = await login(srv.base, "admin", "admin-pass");
      assert.equal((await userCli(srv.dbPath, ["passwd", "admin"], "new-admin-pass")).code, 0);
      assert.equal((await req(srv.base, "GET", "/api/stats", { cookie })).status, 401);
      assert.equal((await req(srv.base, "POST", "/api/auth/login", { body: { username: "admin", password: "admin-pass" } })).status, 401);
      await login(srv.base, "admin", "new-admin-pass");
    } finally {
      await srv.stop();
    }
  });
});

describe("profiles and user management", () => {
  let srv, admin;
  const post = (p, body, cookie) => req(srv.base, "POST", p, { body, cookie });
  before(async () => {
    srv = await startServer({ password: "admin-pass" });
    admin = await login(srv.base, "admin", "admin-pass");
  });
  after(() => srv.stop());

  test("admins list accounts; others cannot", async () => {
    const carol = (await register(srv.base, { username: "carol", password: "carol-pass", display_name: " Carol " })).cookie;
    const me = (await req(srv.base, "GET", "/api/auth/status", { cookie: carol })).json.user;
    assert.deepEqual(me, { id: me.id, username: "carol", display_name: "Carol", is_admin: false });
    assert.equal((await req(srv.base, "GET", "/api/users", { cookie: carol })).status, 403);
    assert.equal((await req(srv.base, "GET", "/api/admin/overview", { cookie: carol })).status, 403);
    // Accounts are only created by signing up: there is no admin creation route.
    assert.equal((await post("/api/users", { username: "eve", password: "eve-password" }, admin)).status, 404);
    const list = (await req(srv.base, "GET", "/api/users", { cookie: admin })).json.users;
    assert.deepEqual(list.map((u) => [u.username, u.is_admin, u.disabled]), [["admin", true, false], ["carol", false, false]]);
  });

  test("display name can be changed and cleared", async () => {
    const r = await post("/api/account", { display_name: "Louis M." }, admin);
    assert.equal(r.json.user.display_name, "Louis M.");
    assert.equal((await post("/api/account", { display_name: "  " }, admin)).json.user.display_name, "admin");
  });

  test("password change needs the current one and signs out other sessions", async () => {
    await register(srv.base, { username: "dave", password: "dave-pass-1" });
    const here = await login(srv.base, "dave", "dave-pass-1");
    const elsewhere = await login(srv.base, "dave", "dave-pass-1");
    assert.equal((await post("/api/account/password", { current_password: "nope", new_password: "dave-pass-2" }, here)).status, 400);
    assert.equal((await post("/api/account/password", { current_password: "dave-pass-1", new_password: "x" }, here)).status, 400);
    assert.equal((await post("/api/account/password", { current_password: "dave-pass-1", new_password: "dave-pass-2" }, here)).status, 200);
    assert.equal((await req(srv.base, "GET", "/api/stats", { cookie: here })).status, 200);
    assert.equal((await req(srv.base, "GET", "/api/stats", { cookie: elsewhere })).status, 401);
    await login(srv.base, "dave", "dave-pass-2");
  });

  test("disabling an account signs it out and stops its devices", async () => {
    await register(srv.base, { username: "frank", password: "frank-pass" });
    const json = { id: await userId(srv.base, "frank", admin) };
    const frank = await login(srv.base, "frank", "frank-pass");
    const dev = await newDevice(srv.base, "frank-laptop", frank);
    assert.equal((await post(`/api/users/${json.id}/disable`, {}, admin)).status, 200);
    assert.equal((await req(srv.base, "GET", "/api/stats", { cookie: frank })).status, 401);
    assert.equal((await post("/api/auth/login", { username: "frank", password: "frank-pass" })).status, 401);
    assert.equal((await req(srv.base, "POST", "/api/ingest", { key: dev.key, body: event() })).status, 401);
    assert.equal((await post(`/api/users/${json.id}/enable`, {}, admin)).status, 200);
    assert.equal((await req(srv.base, "POST", "/api/ingest", { key: dev.key, body: event() })).status, 200);
    await login(srv.base, "frank", "frank-pass");
    assert.equal((await post("/api/users/1/disable", {}, admin)).status, 400);
    assert.equal((await post("/api/users/999/disable", {}, admin)).status, 404);
  });

  test("admins grant and remove admin rights, never their own", async () => {
    const hank = (await register(srv.base, { username: "hank", password: "hank-password" })).cookie;
    const id = await userId(srv.base, "hank", admin);
    assert.equal((await req(srv.base, "GET", "/api/users", { cookie: hank })).status, 403);
    assert.equal((await post(`/api/users/${id}/admin`, { is_admin: "yes" }, admin)).status, 400);
    assert.equal((await post(`/api/users/${id}/admin`, { is_admin: true }, hank)).status, 403);
    assert.equal((await post(`/api/users/${id}/admin`, { is_admin: true }, admin)).status, 200);
    // Takes effect on the next request, same session.
    assert.equal((await req(srv.base, "GET", "/api/auth/status", { cookie: hank })).json.user.is_admin, true);
    assert.equal((await req(srv.base, "GET", "/api/users", { cookie: hank })).status, 200);
    // Nobody changes their own role, so there is always an admin left.
    assert.equal((await post(`/api/users/${id}/admin`, { is_admin: false }, hank)).status, 400);
    assert.equal((await post("/api/users/1/admin", { is_admin: false }, admin)).status, 400);
    assert.equal((await post(`/api/users/${id}/admin`, { is_admin: false }, admin)).status, 200);
    assert.equal((await req(srv.base, "GET", "/api/users", { cookie: hank })).status, 403);
    assert.equal((await post("/api/users/999/admin", { is_admin: true }, admin)).status, 404);
  });

  test("an admin password reset signs that user out", async () => {
    await register(srv.base, { username: "gina", password: "gina-pass-1" });
    const json = { id: await userId(srv.base, "gina", admin) };
    const gina = await login(srv.base, "gina", "gina-pass-1");
    assert.equal((await post(`/api/users/${json.id}/password`, { password: "gina-pass-2" }, admin)).status, 200);
    assert.equal((await req(srv.base, "GET", "/api/stats", { cookie: gina })).status, 401);
    await login(srv.base, "gina", "gina-pass-2");
    // An admin's own password needs the current one (the Account section).
    assert.equal((await post("/api/users/1/password", { password: "taken-over" }, admin)).status, 400);
  });

});

describe("creating accounts from the site", () => {
  test("the first account needs the setup code from the server log", async () => {
    const srv = await startServer({ autoLogin: false });
    try {
      const code = srv.setupCode();
      assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      const key = await genKey(srv.dbPath, "pre-accounts");
      await req(srv.base, "POST", "/api/ingest", { key, body: event() });
      const setup = (body) => req(srv.base, "POST", "/api/auth/setup", { body });
      const me = { username: "louis", password: "first-pass", display_name: "Louis" };
      assert.equal((await setup({ ...me, setup_code: "AAAA-BBBB-CCCC" })).status, 401);
      assert.equal((await setup({ ...me, password: "short", setup_code: code })).status, 400);
      // Case, spaces and dashes do not matter.
      const ok = await setup({ ...me, setup_code: ` ${code.toLowerCase().replace(/-/g, "")} ` });
      assert.equal(ok.status, 200);
      const cookie = ok.headers.get("set-cookie").split(";")[0];
      const st = (await req(srv.base, "GET", "/api/auth/status", { cookie })).json;
      assert.deepEqual(st.user, { id: 1, username: "louis", display_name: "Louis", is_admin: true });
      assert.equal((await req(srv.base, "GET", "/api/stats?days=730", { cookie })).json.events, 1);
      assert.equal((await setup({ ...me, username: "second", setup_code: code })).status, 409);
    } finally {
      await srv.stop();
    }
  });

  test("a server that already has accounts prints no setup code", async () => {
    const srv = await startServer();
    try {
      assert.equal(srv.setupCode(), null);
      assert.equal((await req(srv.base, "POST", "/api/auth/setup", {
        body: { setup_code: "x", username: "evil", password: "evil-password" },
      })).status, 409);
    } finally {
      await srv.stop();
    }
  });
});

describe("open sign-up and admin panel", () => {
  test("anyone creates an account from the sign-in page", async () => {
    const srv = await startServer();
    try {
      assert.equal((await register(srv.base, { username: "neo", password: "short" })).status, 400);
      assert.equal((await register(srv.base, { username: "admin", password: "long-enough" })).status, 409);
      const r = await register(srv.base, { username: "neo", password: "neo-password", display_name: "Neo" });
      assert.equal(r.status, 200);
      const cookie = r.cookie;
      const me = (await req(srv.base, "GET", "/api/auth/status", { cookie })).json.user;
      assert.deepEqual(me, { id: me.id, username: "neo", display_name: "Neo", is_admin: false });
      assert.equal((await req(srv.base, "GET", "/api/admin/overview", { cookie })).status, 403);
      // Sign-up cannot be closed: the setting and its route are gone.
      assert.equal((await req(srv.base, "POST", "/api/admin/settings", { body: { signup_open: false } })).status, 404);
    } finally {
      await srv.stop();
    }
  });

  test("one client cannot create accounts in bulk", async () => {
    const srv = await startServer();
    try {
      // Concurrent requests cannot slip past the limit while passwords hash.
      const burst = await Promise.all([0, 1, 2, 3, 4, 5, 6].map((i) =>
        register(srv.base, { username: `race${i}`, password: "bulk-password" }, "203.0.113.50")));
      assert.deepEqual(burst.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 429, 429]);
      const blocked = await register(srv.base, { username: "bulk5", password: "bulk-password" }, "203.0.113.50");
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get("retry-after")) > 0);
      assert.equal((await register(srv.base, { username: "other", password: "other-password" }, "203.0.113.51")).status, 200);
    } finally {
      await srv.stop();
    }
  });

  test("no open sign-up before the first account exists", async () => {
    const srv = await startServer({ autoLogin: false });
    try {
      assert.equal((await register(srv.base, { username: "neo", password: "neo-password" })).status, 409);
    } finally {
      await srv.stop();
    }
  });

  test("the overview counts the whole server", async () => {
    const srv = await startServer();
    try {
      const { key } = await newDevice(srv.base);
      await req(srv.base, "POST", "/api/ingest", { key, body: event({ session_id: "o1" }) });
      await register(srv.base, { username: "neo", password: "neo-password" });
      const o = (await req(srv.base, "GET", "/api/admin/overview")).json;
      assert.equal(o.accounts, 2);
      assert.equal(o.disabled_accounts, 0);
      assert.equal(o.devices, 1);
      assert.equal(o.events, 1);
      assert.equal(o.sessions, 1);
      assert.ok(o.last_event_at > 0);
    } finally {
      await srv.stop();
    }
  });
});

describe("public profile pages", () => {
  test("anyone reads a profile's usage by username, never its private data", async () => {
    const srv = await startServer();
    try {
      const admin = await login(srv.base, TEST_ADMIN.username, TEST_ADMIN.password);
      await register(srv.base, { username: "bob", password: "bob-password", display_name: "Bob" });
      await register(srv.base, { username: "gone", password: "gone-password" });
      await req(srv.base, "POST", `/api/users/${await userId(srv.base, "gone", admin)}/disable`, { cookie: admin });
      const bob = await login(srv.base, "bob", "bob-password");
      const dev = await newDevice(srv.base, "admin-laptop", admin);
      await req(srv.base, "POST", "/api/ingest", { key: dev.key, body: event({
        session_id: "admin-s",
        rate_limits: { five_hour: { used_percentage: 12, resets_at: 1999999999 } },
      }) });

      // Signed out, and signed in as someone else: same public view.
      for (const cookie of [undefined, bob]) {
        const get = (p) => req(srv.base, "GET", p, cookie ? { cookie } : { anon: true });
        assert.deepEqual((await get("/api/u/admin")).json, { username: "admin", display_name: "admin" });
        assert.equal((await get("/api/u/ADMIN/stats?days=730")).json.events, 1);
        assert.equal((await get("/api/u/admin/summary")).json.total.sessions, 1);
        assert.equal((await get("/api/u/admin/activity")).json.days.length, 1);
        assert.equal((await get("/api/u/admin/quotas")).json.quotas[0].used_pct, 12);
        assert.equal((await get("/api/u/admin/sessions")).json.sessions[0].session_id, "admin-s");
        // Unknown and disabled profiles do not exist.
        assert.equal((await get("/api/u/nobody")).status, 404);
        assert.equal((await get("/api/u/gone/summary")).status, 404);
        // Nothing private has a public route (401 or 404, never data).
        for (const p of ["/api/u/admin/devices", "/api/u/admin/users"]) {
          assert.ok([401, 404].includes((await get(p)).status), p);
        }
      }
      // Bob's own endpoints stay his, whatever the query says.
      const mine = (p) => req(srv.base, "GET", p, { cookie: bob });
      assert.equal((await mine("/api/stats?days=730&user=admin")).json.events, 0);
      assert.deepEqual((await mine("/api/devices")).json.devices, []);
      // The account list is for signed-in users only.
      assert.deepEqual((await mine("/api/profiles")).json.profiles,
        [{ username: "admin", display_name: "admin" }, { username: "bob", display_name: "Bob" }]);
      assert.equal((await req(srv.base, "GET", "/api/profiles", { anon: true })).status, 401);
      assert.equal((await req(srv.base, "GET", "/api/stats", { anon: true })).status, 401);
    } finally {
      await srv.stop();
    }
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
