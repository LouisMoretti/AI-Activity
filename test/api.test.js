import fs from "node:fs";
import Database from "better-sqlite3";
import os from "node:os";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, req, newDevice, event, userCli, login, genKey, register, userId, TEST_ADMIN } from "./helpers.js";

/** A plausible reset time for a current quota window (a far-future one is dropped). */
const soon = () => Math.floor(Date.now() / 1000) + 3600;

describe("basics (signed in as the test admin)", () => {
  let srv, key;
  const stats = async () => (await req(srv.base, "GET", "/api/u/admin/stats?days=730")).json;

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
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: event() })).status, 401);
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: event(), key: "ak_nope" })).status, 401);
    const d = await newDevice(srv.base, "to-revoke");
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: event(), key: d.key })).status, 200);
    assert.equal((await req(srv.base, "POST", `/api/devices/${d.id}/revoke`)).status, 200);
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: event(), key: d.key })).status, 401);
    // Idempotent: SQLite counts matched rows even when the value is unchanged.
    assert.equal((await req(srv.base, "POST", `/api/devices/${d.id}/revoke`)).status, 200);
    assert.equal((await req(srv.base, "POST", "/api/devices/999999/revoke")).status, 404);
  });

  test("ingest rejects bad JSON, oversized bodies and unsupported tools", async () => {
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { raw: "{nope", key })).status, 400);
    const big = JSON.stringify({ pad: "x".repeat(300 * 1024) });
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { raw: big, key })).status, 413);
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: event({ tool: "codex" }), key })).status, 400);
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: event({ tool: "claude" }), key })).status, 400);
  });

  test("ingest is routed by tool slug, with no default tool", async () => {
    // anon: collectors send a device key, never a viewer session cookie.
    const post = (p, body = event()) => req(srv.base, "POST", p, { body, key, anon: true });
    assert.equal((await post("/api/ingest")).status, 404);
    assert.equal((await post("/api/ingest/")).status, 404);
    assert.equal((await post("/api/ingest/codex", event({ tool: "codex" }))).status, 404);
    assert.equal((await post("/api/ingest/constructor")).status, 404);
    assert.equal((await req(srv.base, "GET", "/api/ingest/claude-code", { anon: true })).status, 404);
    assert.equal((await post("/api/ingest/claude-code")).json.stored, true);
    // The payload's tool is optional: the URL already says which tool it is.
    const { tool, ...noTool } = event({ session_id: "slug-only" });
    const r = await req(srv.base, "POST", "/api/ingest/claude-code", { body: noTool, key });
    assert.equal(r.json.stored, true);
  });

  test("measured event shows up in stats, activity and sessions", async () => {
    const before = await stats();
    const ev = event({ session_id: "sess-A" });
    const r = await req(srv.base, "POST", "/api/ingest/claude-code", { body: ev, key });
    assert.equal(r.json.stored, true);
    assert.equal(r.json.deduped, false);
    const after = await stats();
    assert.equal(after.total_tokens - before.total_tokens, 180);
    assert.equal(after.events - before.events, 1);
    assert.equal(after.has_data, true);
    const sessions = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=50")).json.sessions;
    assert.ok(sessions.some((s) => s.session_id === "sess-A" && s.tokens === 180));
  });

  test("replaying the same event_id is deduped, totals unchanged", async () => {
    const ev = event();
    await req(srv.base, "POST", "/api/ingest/claude-code", { body: ev, key });
    const mid = await stats();
    const r = await req(srv.base, "POST", "/api/ingest/claude-code", { body: ev, key });
    assert.equal(r.json.deduped, true);
    assert.deepEqual(await stats(), mid);
  });

  test("same message id: partial then final keeps the final counts, never both", async () => {
    const mid = await stats();
    const partial = event({ event_id: "msg_partial_final", usage: { input_tokens: 2, cache_creation_input_tokens: 8000, output_tokens: 3 } });
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: partial, key })).json.stored, true);
    const final = { ...partial, usage: { ...partial.usage, output_tokens: 983 } };
    const up = await req(srv.base, "POST", "/api/ingest/claude-code", { body: final, key });
    assert.equal(up.json.updated, true);
    // A late partial (fewer output tokens) or an exact replay changes nothing.
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: partial, key })).json.deduped, true);
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: final, key })).json.deduped, true);
    const after = await stats();
    assert.equal(after.total_tokens - mid.total_tokens, 2 + 8000 + 983);
    assert.equal(after.events - mid.events, 1);
  });

  test("batch of transcript messages: one row per message id", async () => {
    const mid = await stats();
    const msg = (id, out) => ({ message_id: id, session_id: "batch-s", model: "claude-opus-5-5", occurred_at: Math.floor(Date.now() / 1000), usage: { input_tokens: 10, output_tokens: out } });
    const body = {
      messages: [msg("msg_b1", 5), msg("msg_b1", 40), msg("msg_b2", 7), { session_id: "batch-s", usage: { input_tokens: 99 } }],
      rate_limits: { five_hour: { used_percentage: 33, resets_at: soon() } },
      account_ref: "batch-acct",
      context: { session_id: "batch-s", used_pct: 61, window_size: 200000 },
    };
    const r = (await req(srv.base, "POST", "/api/ingest/claude-code", { body, key })).json;
    // The entry without a message id is ignored: it cannot be deduplicated.
    assert.deepEqual(r, { ok: true, messages: 3, stored: 2, updated: 1, deduped: 0 });
    const again = (await req(srv.base, "POST", "/api/ingest/claude-code", { body, key })).json;
    assert.deepEqual(again, { ok: true, messages: 3, stored: 0, updated: 0, deduped: 3 });
    const after = await stats();
    assert.equal(after.total_tokens - mid.total_tokens, 50 + 17);
    assert.equal(after.events - mid.events, 2);
    const q = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas;
    assert.ok(q.some((x) => x.account_ref === "batch-acct" && x.used_pct === 33));
    const s = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=50")).json.sessions.find((x) => x.session_id === "batch-s");
    assert.equal(s.context_used_pct, 61);
    assert.equal(s.context_window_size, 200000);
  });

  test("messages replace a session's old statusLine snapshot rows", async () => {
    const mid = await stats();
    // Rows written by the old snapshot collector (the migration marks them 'snapshot').
    const db = new Database(srv.dbPath);
    const { id: deviceId, user_id: uid } = db.prepare("SELECT id, user_id FROM devices ORDER BY id LIMIT 1").get();
    const legacy = db.prepare(
      `INSERT INTO usage_events (event_id, device_id, user_id, tool, session_id, input_tokens, output_tokens, occurred_at, received_at, source)
       VALUES (?, ?, ?, 'claude-code', ?, 500, 5, ?, ?, 'snapshot')`
    );
    const t = Math.floor(Date.now() / 1000);
    legacy.run("old-1", deviceId, uid, "legacy-s", t, t);
    legacy.run("old-2", deviceId, uid, "legacy-s", t, t);
    legacy.run("old-3", deviceId, uid, "other-s", t, t);
    legacy.run("old-early", deviceId, uid, "legacy-s", t - 3600, t - 3600);
    db.close();
    assert.equal((await stats()).total_tokens - mid.total_tokens, 4 * 505);

    const body = { messages: [{ message_id: "msg_legacy_1", session_id: "legacy-s", occurred_at: t, usage: { input_tokens: 500, output_tokens: 5 } }] };
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body, key })).json.stored, 1);
    // From the message's time on, legacy-s counts its one real message.
    // other-s and legacy-s's earlier snapshot (not covered yet) are kept.
    assert.equal((await stats()).total_tokens - mid.total_tokens, 505 + 505 + 505);
    // Once messages reach back that far (the README import), it goes too.
    const early = { messages: [{ message_id: "msg_legacy_0", session_id: "legacy-s", occurred_at: t - 3600, usage: { input_tokens: 1 } }] };
    await req(srv.base, "POST", "/api/ingest/claude-code", { body: early, key });
    assert.equal((await stats()).total_tokens - mid.total_tokens, 505 + 1 + 505);
  });

  test("a snapshot stamped just before its message is replaced too", async () => {
    const mid = await stats();
    const db = new Database(srv.dbPath);
    const { id: deviceId, user_id: uid } = db.prepare("SELECT id, user_id FROM devices ORDER BY id LIMIT 1").get();
    const t = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO usage_events (event_id, device_id, user_id, tool, session_id, input_tokens, occurred_at, received_at, source)
       VALUES ('early-snap', ?, ?, 'claude-code', 'slack-s', 700, ?, ?, 'snapshot')`
    ).run(deviceId, uid, t - 38, t - 38);
    db.close();
    const body = { messages: [{ message_id: "msg_slack_1", session_id: "slack-s", occurred_at: t, usage: { input_tokens: 700 } }] };
    await req(srv.base, "POST", "/api/ingest/claude-code", { body, key });
    assert.equal((await stats()).total_tokens - mid.total_tokens, 700);
  });

  test("quota shows the current window's highest value, not the last post", async () => {
    const now = Math.floor(Date.now() / 1000);
    const post = (pct, resets, at) => req(srv.base, "POST", "/api/ingest/claude-code", {
      key, body: { account_ref: "stale", occurred_at: at, rate_limits: { five_hour: { used_percentage: pct, resets_at: resets } } },
    });
    const shown = async () => (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas.find((q) => q.account_ref === "stale");
    // A far-future reset is dropped at ingest: it would pin the window.
    await post(23.5, 1999999999, now - 30);
    assert.equal(await shown(), undefined);
    // A day-old bogus row stored before that check must not win either.
    const db = new Database(srv.dbPath);
    const { id: deviceId, user_id: uid } = db.prepare("SELECT id, user_id FROM devices ORDER BY id LIMIT 1").get();
    db.prepare(
      `INSERT INTO quota_snapshots (device_id, user_id, account_ref, tool, limit_type, used_pct, resets_at, measured_at)
       VALUES (?, ?, 'stale', 'claude-code', 'five_hour', 23.5, 1999999999, ?)`
    ).run(deviceId, uid, now - 2 * 86400);
    db.close();
    await post(35, now + 3600, now - 60);
    // A second terminal posts the same window's older, lower value later.
    await post(20, now + 3600, now - 10);
    assert.deepEqual([(await shown()).used_pct, (await shown()).resets_at], [35, now + 3600]);
    // …or the previous, already reset window.
    await post(90, now - 100, now - 5);
    assert.equal((await shown()).used_pct, 35);
    // The next window replaces it, even with a lower value.
    await post(4, now + 18000, now);
    assert.deepEqual([(await shown()).used_pct, (await shown()).resets_at], [4, now + 18000]);
  });

  test("usage without an Anthropic message id is not stored", async () => {
    const before = await stats();
    // The old reference collector sent a fresh random UUID on every fire.
    for (const id of ["0b9f1c2e-5d6a-4f7b-8c9d-0e1f2a3b4c5d", "e-123", "msg_", "msg_bad id"]) {
      const r = await req(srv.base, "POST", "/api/ingest/claude-code", { body: event({ event_id: id }), key });
      assert.deepEqual(r.json, { ok: true, stored: false, updated: false, deduped: false, event_id: null });
    }
    const batch = { messages: [{ message_id: "not-a-message-id", usage: { input_tokens: 5 } }] };
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: batch, key })).json.messages, 0);
    assert.equal((await stats()).total_tokens, before.total_tokens);
  });

  test("a message id stored by another account is never overwritten", async () => {
    const bob = await register(srv.base, { username: "msgbob", password: "bob-password-1" });
    const bobKey = (await newDevice(srv.base, "bob-dev", bob.cookie)).key;
    const mine = event({ event_id: "msg_shared_id", usage: { input_tokens: 1, output_tokens: 1 } });
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: mine, key })).json.stored, true);
    const theirs = { ...mine, usage: { input_tokens: 1, output_tokens: 999999 } };
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: theirs, key: bobKey })).json.deduped, true);
    const bobStats = (await req(srv.base, "GET", "/api/u/msgbob/stats?days=730")).json;
    assert.equal(bobStats.total_tokens, 0);
  });

  test("empty snapshot stores no usage row but records quotas", async () => {
    const before = await stats();
    const r = await req(srv.base, "POST", "/api/ingest/claude-code", {
      key,
      body: event({ usage: {}, account_ref: "empty-acct", rate_limits: { five_hour: { used_percentage: 12, resets_at: soon() } } }),
    });
    assert.equal(r.json.stored, false);
    assert.equal((await stats()).events, before.events);
    const q = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas;
    assert.ok(q.some((x) => x.account_ref === "empty-acct" && x.used_pct === 12));
  });

  test("raw statusLine snapshot stores no usage (it re-fires per API call) but keeps quotas", async () => {
    const before = await stats();
    const r = await req(srv.base, "POST", "/api/ingest/claude-code", {
      key,
      body: {
        session_id: "raw-sess", prompt_id: "raw-p",
        model: { id: "claude-sonnet-5", display_name: "Sonnet" },
        context_window: { current_usage: { input_tokens: 1000, output_tokens: 1 } },
        rate_limits: { seven_day: { used_percentage: 44, resets_at: soon() } },
        account_ref: "raw-acct",
        cost: { total_cost_usd: 99 },
      },
    });
    assert.deepEqual(r.json, { ok: true, stored: false, updated: false, deduped: false, event_id: null });
    const after = await stats();
    assert.equal(after.total_tokens, before.total_tokens);
    assert.equal(after.estimated_usd, undefined);
    const q = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas;
    assert.ok(q.some((x) => x.account_ref === "raw-acct" && x.used_pct === 44));
  });

  test("two devices on the same account: latest quota snapshot wins, never summed", async () => {
    const other = (await newDevice(srv.base, "second")).key;
    const resets = soon();
    const rl = (pct) => ({ five_hour: { used_percentage: pct, resets_at: resets } });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ account_ref: "shared", rate_limits: rl(30) }) });
    await new Promise((r) => setTimeout(r, 1100)); // measured_at has 1 s resolution
    await req(srv.base, "POST", "/api/ingest/claude-code", { key: other, body: event({ account_ref: "shared", rate_limits: rl(45) }) });
    const rows = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas
      .filter((q) => q.account_ref === "shared" && q.limit_type === "five_hour");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].used_pct, 45);
  });

  test("snapshots within the same second still yield one row per window", async () => {
    const rl = (pct) => ({ seven_day: { used_percentage: pct } });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ account_ref: "fast", rate_limits: rl(10) }) });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ account_ref: "fast", rate_limits: rl(11) }) });
    const rows = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas.filter((q) => q.account_ref === "fast");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].used_pct, 11);
  });

  test("a replayed stale snapshot does not replace a newer quota", async () => {
    const now = Math.floor(Date.now() / 1000);
    const q = (pct) => ({ five_hour: { used_percentage: pct, resets_at: now + 3600 } });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ account_ref: "replay", rate_limits: q(60), occurred_at: now }) });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ account_ref: "replay", rate_limits: q(10), occurred_at: now - 7200 }) });
    const quotas = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas.filter((x) => x.account_ref === "replay");
    assert.equal(quotas.length, 1);
    assert.equal(quotas[0].used_pct, 60);
  });

  test("an unchanged quota value refreshes its measured_at", async () => {
    const now = Math.floor(Date.now() / 1000);
    const q = { seven_day: { used_percentage: 12, resets_at: now + 86400 } };
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ account_ref: "same", rate_limits: q, occurred_at: now - 60 }) });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ account_ref: "same", rate_limits: q, occurred_at: now }) });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ account_ref: "same", rate_limits: q, occurred_at: now - 30 }) });
    const rows = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas.filter((x) => x.account_ref === "same");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].used_pct, 12);
    assert.equal(rows[0].measured_at, now);
  });

  test("payload without rate_limits creates no quota rows", async () => {
    const before = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas.length;
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ account_ref: "no-limits" }) });
    const q = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas;
    assert.equal(q.length, before);
    assert.ok(!q.some((x) => x.account_ref === "no-limits"));
  });

  test("spooled events with old occurred_at land on their own day, ordered", async () => {
    const day = 86400;
    const now = Math.floor(Date.now() / 1000);
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ occurred_at: now - 3 * day }) });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ occurred_at: (now - 10 * day) * 1000 }) }); // ms accepted
    const days = (await req(srv.base, "GET", "/api/u/admin/activity?days=30")).json.days.map((d) => d.day);
    assert.deepEqual(days, [...days].sort());
    const iso = (s) => new Date(s * 1000).toISOString().slice(0, 10);
    assert.ok(days.includes(iso(now - 3 * day)));
    assert.ok(days.includes(iso(now - 10 * day)));
  });

  test("occurred_at in the future is clamped to the receive time", async () => {
    const now = Math.floor(Date.now() / 1000);
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ session_id: "future", occurred_at: now + 400 * 86400 }) });
    const s = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=200")).json.sessions.find((x) => x.session_id === "future");
    assert.ok(s.last_seen <= Math.floor(Date.now() / 1000));
    assert.ok(s.last_seen >= now);
  });

  test("a session reports its latest model, not the largest name", async () => {
    const now = Math.floor(Date.now() / 1000);
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ session_id: "switch", model: "claude-sonnet-5", occurred_at: now - 60 }) });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ session_id: "switch", model: "claude-opus-5-5", occurred_at: now }) });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ session_id: "switch", model: "claude-haiku-4-5", occurred_at: now - 30 }) });
    const s = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=200")).json.sessions.find((x) => x.session_id === "switch");
    assert.equal(s.model, "claude-opus-5-5");
  });

  test("sessions page with offset past the per-request cap", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 5; i++) {
      await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ session_id: `page-${i}`, occurred_at: now + i }) });
    }
    const all = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=200")).json;
    const p1 = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=2")).json.sessions;
    const p2 = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=2&offset=2")).json.sessions;
    assert.deepEqual([...p1, ...p2].map((s) => s.session_id), all.sessions.slice(0, 4).map((s) => s.session_id));
    const past = (await req(srv.base, "GET", `/api/u/admin/sessions?limit=5&offset=${all.total}`)).json;
    assert.deepEqual(past.sessions, []);
    assert.equal(past.total, all.total);
  });

  test("removed routes are gone", async () => {
    assert.equal((await req(srv.base, "GET", "/api/billing")).status, 404);
    // Own usage is read from the public profile, like anyone else's.
    for (const p of ["/api/stats", "/api/activity", "/api/quotas", "/api/summary", "/api/sessions"]) {
      assert.equal((await req(srv.base, "GET", p)).status, 404, p);
    }
    assert.equal((await req(srv.base, "POST", "/api/billing/subscription", { body: { tool: "claude-code" } })).status, 404);
  });

  test("tool filter on stats", async () => {
    const r = (await req(srv.base, "GET", "/api/u/admin/stats?days=30&tool=codex")).json;
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
      assert.doesNotMatch(r.text, /"dependencies"|DB_PATH/, p);
    }
  });
});

describe("locked server (first account made from the CLI)", () => {
  let srv;
  before(async () => { srv = await startServer({ password: "hunter2-pass" }); });
  after(() => srv.stop());

  test("viewer APIs require login; ingest and health stay reachable", async () => {
    assert.equal((await req(srv.base, "GET", "/api/health")).status, 200);
    assert.equal((await req(srv.base, "GET", "/api/devices")).status, 401);
    assert.equal((await req(srv.base, "POST", "/api/devices", { body: { name: "x" } })).status, 401);
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: event(), key: "ak_nope" })).status, 401);
    const st = (await req(srv.base, "GET", "/api/auth/status")).json;
    assert.deepEqual(st, { authenticated: false, user: null, setup_required: false, signup_open: true });
  });

  test("login / logout cycle", async () => {
    const bad = (body) => req(srv.base, "POST", "/api/auth/login", { body });
    assert.equal((await bad({ username: "admin", password: "wrong" })).status, 401);
    assert.equal((await bad({ password: "hunter2-pass" })).status, 401);
    // Unknown user and wrong password are indistinguishable.
    assert.deepEqual((await bad({ username: "nobody", password: "hunter2-pass" })).json,
      (await bad({ username: "admin", password: "nope" })).json);
    const ok = await req(srv.base, "POST", "/api/auth/login", { body: { username: "ADMIN", password: "hunter2-pass" } });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get("set-cookie").split(";")[0];
    assert.match(ok.headers.get("set-cookie"), /HttpOnly/);
    assert.equal((await req(srv.base, "GET", "/api/devices", { cookie })).status, 200);
    const me = (await req(srv.base, "GET", "/api/auth/status", { cookie })).json;
    assert.deepEqual(me.user, { id: 1, username: "admin", display_name: "admin", avatar_url: null, is_admin: true });
    const d = await newDevice(srv.base, "locked-dev", cookie);
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: event(), key: d.key })).json.stored, true);
    await req(srv.base, "POST", "/api/auth/logout", { cookie });
    assert.equal((await req(srv.base, "GET", "/api/devices", { cookie })).status, 401);
  });

  test("session cookie is Secure only over HTTPS", async () => {
    const plain = await req(srv.base, "POST", "/api/auth/login", { body: { username: "admin", password: "hunter2-pass" } });
    assert.doesNotMatch(plain.headers.get("set-cookie"), /Secure/);
    const r = await fetch(srv.base + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ username: "admin", password: "hunter2-pass" }),
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
    const blocked = await attempt("hunter2-pass", "203.0.113.9");
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    assert.equal((await attempt("hunter2-pass", "203.0.113.10")).status, 200);
  });

  test("signing in to another account between guesses does not reset the count", async () => {
    const ip = "203.0.113.20";
    const attempt = (username, password) => req(srv.base, "POST", "/api/auth/login", {
      anon: true, body: { username, password }, headers: { "cf-connecting-ip": ip },
    });
    assert.equal((await register(srv.base, { username: "guesser", password: "guesser-pass" })).status, 200);
    for (let i = 0; i < 9; i++) assert.equal((await attempt("admin", "nope")).status, 401);
    assert.equal((await attempt("guesser", "guesser-pass")).status, 200);
    assert.equal((await attempt("admin", "nope")).status, 401);
    assert.equal((await attempt("admin", "nope")).status, 429);
    assert.equal((await attempt("guesser", "guesser-pass")).status, 429);
  });

  test("state-changing requests must be same-site JSON", async () => {
    const cookie = await login(srv.base, "admin", "hunter2-pass");
    // A cross-site HTML form can send text/plain that happens to be JSON.
    const form = await req(srv.base, "POST", "/api/auth/login", {
      anon: true, type: "text/plain", raw: JSON.stringify({ username: "admin", password: "hunter2-pass" }),
    });
    assert.equal(form.status, 415);
    assert.equal(form.headers.get("set-cookie"), null);
    assert.equal((await req(srv.base, "POST", "/api/auth/logout", { type: null, cookie })).status, 415);
    assert.equal((await req(srv.base, "POST", "/api/account", { type: "application/x-www-form-urlencoded", raw: "display_name=x", cookie })).status, 415);
    const cross = await req(srv.base, "POST", "/api/account", { body: { display_name: "x" }, headers: { "sec-fetch-site": "cross-site" }, cookie });
    assert.equal(cross.status, 403);
    assert.equal((await req(srv.base, "POST", "/api/account", { body: {}, type: "application/json; charset=utf-8", cookie })).status, 200);
    assert.equal((await req(srv.base, "GET", "/api/devices", { type: "text/plain", cookie })).status, 200);
  });

  test("a device name that is not text falls back to the default", async () => {
    const cookie = await login(srv.base, "admin", "hunter2-pass");
    const r = await req(srv.base, "POST", "/api/devices", { body: { name: { toString: 1 } }, cookie });
    assert.equal(r.status, 200);
    const d = (await req(srv.base, "GET", "/api/devices", { cookie })).json.devices.find((x) => x.id === r.json.id);
    assert.equal(d.name, "unnamed device");
  });
});

describe("login throttling under load", () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => srv.stop());

  test("a burst of parallel guesses is counted before hashing", async () => {
    const guess = () => req(srv.base, "POST", "/api/auth/login", {
      anon: true, body: { username: "admin", password: "nope" }, headers: { "cf-connecting-ip": "203.0.113.30" },
    });
    const statuses = (await Promise.all(Array.from({ length: 40 }, guess))).map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 401).length, 10);
    assert.equal(statuses.filter((s) => s === 429).length, 30);
  });

  test("CF-Connecting-IP is only trusted from localhost", async (t) => {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
    if (!lan) return t.skip("no non-loopback IPv4 address to connect from");
    const base = srv.base.replace("localhost", lan.address).replace("127.0.0.1", lan.address);
    // From the LAN, a new header on every request must not buy a new budget.
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await req(base, "POST", "/api/auth/register", {
        anon: true, body: { username: `lan${i}`, password: "lan-password-1" }, headers: { "cf-connecting-ip": `198.51.100.${i}` },
      })).status);
    }
    assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.ok(statuses.slice(5).every((s) => s === 429), String(statuses));
  });
});

describe("accounts", () => {
  test("nothing is viewable without an account; the first one claims the existing data", async () => {
    const srv = await startServer({ autoLogin: false });
    try {
      assert.deepEqual((await req(srv.base, "GET", "/api/auth/status")).json,
        { authenticated: false, user: null, setup_required: true, signup_open: true });
      for (const p of ["/api/devices", "/api/users", "/api/admin/overview"]) {
        assert.equal((await req(srv.base, "GET", p)).status, 401, p);
      }
      // The public account list is empty until the first account exists.
      assert.deepEqual((await req(srv.base, "GET", "/api/profiles")).json.profiles, []);
      assert.equal((await req(srv.base, "POST", "/api/devices", { body: { name: "x" } })).status, 401);
      assert.equal((await req(srv.base, "POST", "/api/auth/login", { body: { username: "x", password: "y" } })).status, 400);
      // Collectors keep working before any account exists (keys from the CLI).
      const key = await genKey(srv.dbPath, "pre-accounts");
      assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event() })).json.stored, true);

      const add = await userCli(srv.dbPath, ["add", "louis", "--name", "Louis"], "correct horse");
      assert.equal(add.code, 0, add.out);
      const cookie = await login(srv.base, "louis", "correct horse");
      const st = (await req(srv.base, "GET", "/api/auth/status", { cookie })).json;
      assert.deepEqual(st, {
        authenticated: true, setup_required: false, signup_open: true,
        user: { id: 1, username: "louis", display_name: "Louis", avatar_url: null, is_admin: true },
      });
      assert.equal((await req(srv.base, "GET", "/api/u/louis/stats?days=730", { cookie })).json.events, 1);
      assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event() })).json.stored, true);
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

  test("usage lands on the device owner; devices stay private", async () => {
    const srv = await startServer({ password: "admin-pass" });
    try {
      assert.equal((await userCli(srv.dbPath, ["add", "bob"], "bob-password")).code, 0);
      const admin = await login(srv.base, "admin", "admin-pass");
      const bob = await login(srv.base, "bob", "bob-password");
      const adminDev = await newDevice(srv.base, "admin-laptop", admin);
      const bobDev = await newDevice(srv.base, "bob-laptop", bob);
      await req(srv.base, "POST", "/api/ingest/claude-code", { key: bobDev.key, body: event({
        session_id: "bob-s",
        rate_limits: { five_hour: { used_percentage: 42, resets_at: soon() } },
      }) });

      const get = async (p, cookie) => (await req(srv.base, "GET", p, { cookie })).json;
      assert.equal((await get("/api/u/admin/stats?days=730", admin)).events, 0);
      assert.equal((await get("/api/u/bob/stats?days=730", bob)).events, 1);
      assert.deepEqual((await get("/api/u/admin/quotas", admin)).quotas, []);
      assert.equal((await get("/api/u/bob/quotas", bob)).quotas.length, 1);
      assert.equal((await get("/api/u/admin/sessions", admin)).total, 0);
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
      assert.equal((await req(srv.base, "GET", "/api/devices", { cookie: first })).status, 401);
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
        assert.equal((await req(second.base, "GET", "/api/devices", { cookie })).status, 200);
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
      assert.equal((await req(srv.base, "GET", "/api/devices", { cookie })).status, 401);
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
    assert.deepEqual(me, { id: me.id, username: "carol", display_name: "Carol", avatar_url: null, is_admin: false });
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

  test("profile picture: only https links to allowed image hosts, public everywhere", async () => {
    const pic = "https://avatars.githubusercontent.com/u/12345?v=4";
    const r = await post("/api/account", { avatar_url: ` ${pic} ` }, admin);
    assert.equal(r.json.user.avatar_url, pic);
    // Changing only the picture keeps the display name, and the other way round.
    assert.equal(r.json.user.display_name, "admin");
    assert.equal((await post("/api/account", { display_name: "Admin" }, admin)).json.user.avatar_url, pic);
    for (const ok of ["https://github.com/octocat.png", "https://www.gravatar.com/avatar/" + "a".repeat(32) + "?s=200",
      "https://i.imgur.com/abc1234.jpg"]) {
      assert.equal((await post("/api/account", { avatar_url: ok }, admin)).status, 200, ok);
    }
    for (const bad of ["http://github.com/octocat.png", "https://evil.example/x.png", "https://github.com/octocat",
      "https://user:pw@i.imgur.com/abc1234.jpg", "https://i.imgur.com:8443/abc1234.jpg", "javascript:alert(1)",
      "https://github.com.evil.example/a.png", "https://gist.github.com/x.png", 42, "https://i.imgur.com/" + "a".repeat(600)]) {
      assert.equal((await post("/api/account", { avatar_url: bad }, admin)).status, 400, String(bad));
    }
    await post("/api/account", { avatar_url: pic }, admin);
    const anon = { anon: true };
    assert.equal((await req(srv.base, "GET", "/api/u/admin", anon)).json.avatar_url, pic);
    const board = (await req(srv.base, "GET", "/api/leaderboard?days=30", anon)).json;
    assert.equal(board.entries.find((e) => e.username === "admin").avatar_url, pic);
    // Empty clears it.
    assert.equal((await post("/api/account", { avatar_url: "" }, admin)).json.user.avatar_url, null);
    await post("/api/account", { display_name: "" }, admin);
  });

  test("password change needs the current one and signs out other sessions", async () => {
    await register(srv.base, { username: "dave", password: "dave-pass-1" });
    const here = await login(srv.base, "dave", "dave-pass-1");
    const elsewhere = await login(srv.base, "dave", "dave-pass-1");
    assert.equal((await post("/api/account/password", { current_password: "nope", new_password: "dave-pass-2" }, here)).status, 400);
    assert.equal((await post("/api/account/password", { current_password: "dave-pass-1", new_password: "x" }, here)).status, 400);
    assert.equal((await post("/api/account/password", { current_password: "dave-pass-1", new_password: "dave-pass-2" }, here)).status, 200);
    assert.equal((await req(srv.base, "GET", "/api/devices", { cookie: here })).status, 200);
    assert.equal((await req(srv.base, "GET", "/api/devices", { cookie: elsewhere })).status, 401);
    await login(srv.base, "dave", "dave-pass-2");
  });

  test("disabling an account signs it out and stops its devices", async () => {
    await register(srv.base, { username: "frank", password: "frank-pass" });
    const json = { id: await userId(srv.base, "frank", admin) };
    const frank = await login(srv.base, "frank", "frank-pass");
    const dev = await newDevice(srv.base, "frank-laptop", frank);
    assert.equal((await post(`/api/users/${json.id}/disable`, {}, admin)).status, 200);
    assert.equal((await req(srv.base, "GET", "/api/devices", { cookie: frank })).status, 401);
    assert.equal((await post("/api/auth/login", { username: "frank", password: "frank-pass" })).status, 401);
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { key: dev.key, body: event() })).status, 401);
    assert.equal((await post(`/api/users/${json.id}/enable`, {}, admin)).status, 200);
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { key: dev.key, body: event() })).status, 200);
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
    assert.equal((await req(srv.base, "GET", "/api/devices", { cookie: gina })).status, 401);
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
      await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event() });
      const setup = (body) => req(srv.base, "POST", "/api/auth/setup", { body });
      const me = { username: "louis", password: "first-pass", display_name: "Louis" };
      assert.equal((await setup({ ...me, setup_code: "AAAA-BBBB-CCCC" })).status, 401);
      assert.equal((await setup({ ...me, password: "short", setup_code: code })).status, 400);
      // Case, spaces and dashes do not matter.
      const ok = await setup({ ...me, setup_code: ` ${code.toLowerCase().replace(/-/g, "")} ` });
      assert.equal(ok.status, 200);
      const cookie = ok.headers.get("set-cookie").split(";")[0];
      const st = (await req(srv.base, "GET", "/api/auth/status", { cookie })).json;
      assert.deepEqual(st.user, { id: 1, username: "louis", display_name: "Louis", avatar_url: null, is_admin: true });
      assert.equal((await req(srv.base, "GET", "/api/u/louis/stats?days=730", { cookie })).json.events, 1);
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
      assert.deepEqual(me, { id: me.id, username: "neo", display_name: "Neo", avatar_url: null, is_admin: false });
      assert.equal((await req(srv.base, "GET", "/api/admin/overview", { cookie })).status, 403);
    } finally {
      await srv.stop();
    }
  });

  test("an admin closes and reopens account creation", async () => {
    const srv = await startServer();
    try {
      const neo = (await register(srv.base, { username: "neo", password: "neo-password" })).cookie;
      const settings = (body, cookie) => req(srv.base, "POST", "/api/admin/settings", { body, cookie });
      assert.equal((await req(srv.base, "GET", "/api/admin/settings", { cookie: neo })).status, 403);
      assert.equal((await settings({ signup_open: false }, neo)).status, 403);
      assert.equal((await settings({ signup_open: "no" })).status, 400);
      assert.deepEqual((await settings({ signup_open: false })).json, { signup_open: false });
      assert.equal((await req(srv.base, "GET", "/api/auth/status", { anon: true })).json.signup_open, false);
      assert.equal((await register(srv.base, { username: "trinity", password: "trinity-password" })).status, 403);
      // Existing accounts still sign in, and the CLI still creates accounts.
      await login(srv.base, "neo", "neo-password");
      assert.equal((await userCli(srv.dbPath, ["add", "morpheus"], "morpheus-password")).code, 0);
      assert.deepEqual((await settings({ signup_open: true })).json, { signup_open: true });
      assert.equal((await register(srv.base, { username: "trinity", password: "trinity-password" })).status, 200);
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
      await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ session_id: "o1" }) });
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
      await req(srv.base, "POST", "/api/ingest/claude-code", { key: dev.key, body: event({
        session_id: "admin-s",
        rate_limits: { five_hour: { used_percentage: 12, resets_at: soon() } },
      }) });

      // Signed out, and signed in as someone else: same public view.
      for (const cookie of [undefined, bob]) {
        const get = (p) => req(srv.base, "GET", p, cookie ? { cookie } : { anon: true });
        assert.deepEqual((await get("/api/u/admin")).json, { username: "admin", display_name: "admin", avatar_url: null });
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
      // Bob's devices stay his.
      const mine = (p) => req(srv.base, "GET", p, { cookie: bob });
      assert.deepEqual((await mine("/api/devices")).json.devices, []);
      // The account list is public, like the leaderboard (disabled ones hidden).
      const listed = [{ username: "admin", display_name: "admin", avatar_url: null }, { username: "bob", display_name: "Bob", avatar_url: null }];
      assert.deepEqual((await mine("/api/profiles")).json.profiles, listed);
      assert.deepEqual((await req(srv.base, "GET", "/api/profiles", { anon: true })).json.profiles, listed);
      assert.equal((await req(srv.base, "GET", "/api/devices", { anon: true })).status, 401);
    } finally {
      await srv.stop();
    }
  });
});

describe("read cache", () => {
  let srv, key;
  before(async () => {
    srv = await startServer();
    key = (await newDevice(srv.base, "cache")).key;
  });
  after(() => srv.stop());

  test("public reads are fresh after any write, from the server or the CLI", async () => {
    const board = async () => (await req(srv.base, "GET", "/api/leaderboard?days=30", { anon: true })).json;
    const tokens = async () => (await req(srv.base, "GET", "/api/u/admin/summary", { anon: true })).json.total.tokens;
    const before = await board();
    assert.deepEqual(await board(), before);
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ usage: { input_tokens: 5 } }) });
    assert.equal((await board()).totals.tokens, before.totals.tokens + 5);
    assert.equal(await tokens(), before.totals.tokens + 5);
    // Another connection (the CLI) writing to the same DB.
    assert.equal((await userCli(srv.dbPath, ["add", "cliuser"], "cli-password-1")).code, 0);
    assert.ok((await board()).entries.some((e) => e.username === "cliuser"));
  });

  test("read indexes replace the old ones", async () => {
    const db = new Database(srv.dbPath, { readonly: true });
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_events'").all().map((r) => r.name);
    db.close();
    assert.ok(names.includes("idx_usage_user_read") && names.includes("idx_usage_user_session_read"), String(names));
    assert.ok(!names.includes("idx_usage_device_prompt") && !names.includes("idx_usage_user_time"), String(names));
  });
});

describe("leaderboard", () => {
  test("ranks every enabled account by tokens, publicly", async () => {
    const srv = await startServer();
    try {
      const admin = await login(srv.base, TEST_ADMIN.username, TEST_ADMIN.password);
      const bob = (await register(srv.base, { username: "bob", password: "bob-password", display_name: "Bob" })).cookie;
      await register(srv.base, { username: "idle", password: "idle-password" });
      const gone = (await register(srv.base, { username: "gone", password: "gone-password" })).cookie;
      const now = Math.floor(Date.now() / 1000);
      const post = (key, over) => req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event(over) });
      const adminKey = (await newDevice(srv.base, "a", admin)).key;
      const bobKey = (await newDevice(srv.base, "b", bob)).key;
      const goneKey = (await newDevice(srv.base, "g", gone)).key;
      // admin: 180 tokens today; bob: 180 today + 180 yesterday + 1800 sixty days ago.
      await post(adminKey, { session_id: "a1" });
      await post(bobKey, { session_id: "b1", model: "claude-sonnet-5" });
      await post(bobKey, { session_id: "b2", model: "claude-sonnet-5", occurred_at: now - 86400 });
      await post(bobKey, { session_id: "b3", occurred_at: now - 60 * 86400,
        usage: { input_tokens: 1000, output_tokens: 800 } });
      await post(goneKey, { session_id: "g1", usage: { input_tokens: 99999 } });
      await req(srv.base, "POST", `/api/users/${await userId(srv.base, "gone", admin)}/disable`, { cookie: admin });

      // Public, like profile pages: same answer for visitors.
      const month = (await req(srv.base, "GET", "/api/leaderboard?days=30", { anon: true })).json;
      assert.deepEqual((await req(srv.base, "GET", "/api/leaderboard?days=30", { cookie: bob })).json, month);
      assert.equal(month.range_days, 30);
      assert.equal(month.accounts, 3);
      assert.deepEqual(month.totals, { tokens: 540, sessions: 3, events: 3, active_accounts: 2 });
      // Idle accounts are listed too, last, with zeros.
      assert.deepEqual(month.entries.map((e) => [e.username, e.tokens]), [["bob", 360], ["admin", 180], ["idle", 0]]);
      assert.deepEqual(month.entries[2], {
        username: "idle", display_name: "idle", avatar_url: null, tokens: 0, sessions: 0, events: 0, active_days: 0,
        top_model: null, last_active: null, current_streak: 0,
      });
      const b = month.entries[0];
      assert.equal(b.display_name, "Bob");
      assert.equal(b.sessions, 2);
      assert.equal(b.active_days, 2);
      assert.equal(b.top_model, "claude-sonnet-5");
      assert.equal(b.current_streak, 2); // events today and yesterday
      assert.equal(month.entries[1].current_streak, 1);
      assert.deepEqual(month.by_model.map((m) => m.name), ["claude-sonnet-5", "claude-opus-5-5"]);

      const all = (await req(srv.base, "GET", "/api/leaderboard?days=all", { cookie: bob })).json;
      assert.equal(all.range_days, null);
      assert.equal(all.entries[0].tokens, 2160);
      assert.equal(all.entries[0].top_model, "claude-opus-5-5");
      assert.equal(all.activity.reduce((a, d) => a + d.tokens, 0), 2340);
      // Disabled accounts never appear.
      assert.ok(!all.entries.some((e) => e.username === "gone"));
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
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ session_id: "a", model: "claude-opus-5-5", occurred_at: now }) });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ session_id: "b", model: "claude-sonnet-5", occurred_at: now - 40 * 86400 }) });
    const s = (await req(srv.base, "GET", "/api/u/admin/summary")).json;
    assert.equal(s.total.tokens, 360);
    assert.equal(s.total.sessions, 2);
    assert.equal(s.today.tokens, 180);
    assert.equal(s.today.sessions, 1);
    assert.deepEqual(s.total.by_model.map((r) => r.name).sort(), ["claude-opus-5-5", "claude-sonnet-5"]);
    assert.deepEqual(s.total.by_tool, [{ name: "claude-code", tokens: 360, sessions: 2, events: 2 }]);
    assert.equal(s.day, new Date().toISOString().slice(0, 10));
    assert.equal((await req(srv.base, "GET", "/api/u/admin/summary?tool=codex")).json.total.tokens, 0);
  });

  test("sessions report the latest context fill and a total for paging", async () => {
    const at = Math.floor(Date.now() / 1000);
    const m = (id, t) => ({ message_id: id, session_id: "ctx", occurred_at: t, usage: { input_tokens: 5 } });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: { messages: [m("msg_c1", at - 10), m("msg_c2", at)] } });
    // A raw statusLine payload puts its gauge on the session's newest row.
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: {
      session_id: "ctx", context_window: { context_window_size: 200000, used_percentage: 20, current_usage: { input_tokens: 5 } },
    } });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: {
      session_id: "ctx", context_window: { context_window_size: 200000, used_percentage: 35 },
    } });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: { messages: [m("msg_c3", at - 5)] } });
    const r = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=1")).json;
    assert.equal(r.sessions.length, 1);
    assert.equal(r.total, 3); // sessions a, b and ctx
    const ctx = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=50")).json.sessions.find((s) => s.session_id === "ctx");
    assert.equal(ctx.context_used_pct, 35);
    assert.equal(ctx.context_window_size, 200000);
    const noCtx = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=50")).json.sessions.find((s) => s.session_id === "a");
    assert.equal(noCtx.context_used_pct, null);
    assert.equal((await req(srv.base, "GET", "/api/u/admin/sessions?tool=codex")).json.total, 0);
  });
});

describe("shutdown", () => {
  test("SIGTERM closes the server and checkpoints the SQLite WAL", async () => {
    const srv = await startServer();
    try {
      const { key } = await newDevice(srv.base);
      await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event() });
      assert.ok(fs.existsSync(`${srv.dbPath}-wal`));
      assert.equal(await srv.kill(), 0);
      assert.ok(!fs.existsSync(`${srv.dbPath}-wal`));
    } finally {
      await srv.stop();
    }
  });
});

describe("limits, bounds and admin edge cases", () => {
  test("the global cap of 50 failures locks every client, owner included", async () => {
    const srv = await startServer();
    try {
      const attempt = (ip, password = "nope") => req(srv.base, "POST", "/api/auth/login", {
        anon: true, body: { username: TEST_ADMIN.username, password }, headers: { "cf-connecting-ip": ip },
      });
      for (let c = 0; c < 5; c++) for (let i = 0; i < 10; i++) assert.equal((await attempt(`203.0.113.${100 + c}`)).status, 401);
      const owner = await attempt("203.0.113.200", TEST_ADMIN.password);
      assert.equal(owner.status, 429);
      assert.ok(Number(owner.headers.get("retry-after")) > 0);
      // Sign-up is refused while the cap holds, too.
      const r = await req(srv.base, "POST", "/api/auth/register", {
        anon: true, body: { username: "late", password: "late-password" }, headers: { "cf-connecting-ip": "203.0.113.201" },
      });
      assert.equal(r.status, 429);
    } finally {
      srv.stop();
    }
  });

  test("guessing the current password is throttled like a login", async () => {
    const srv = await startServer();
    try {
      const change = (current) => req(srv.base, "POST", "/api/account/password", {
        body: { current_password: current, new_password: "new-password-1" },
      });
      for (let i = 0; i < 10; i++) assert.equal((await change("nope")).status, 400);
      assert.equal((await change(TEST_ADMIN.password)).status, 429);
    } finally {
      srv.stop();
    }
  });

  test("query parameters are clamped to their documented bounds", async () => {
    const srv = await startServer();
    try {
      const days = async (q) => (await req(srv.base, "GET", `/api/u/admin/stats?${q}`)).json.range_days;
      assert.deepEqual([await days("days=99999"), await days("days=-5"), await days("days=abc"), await days("")], [730, 1, 30, 30]);
      const board = async (q) => (await req(srv.base, "GET", `/api/leaderboard?${q}`, { anon: true })).json.range_days;
      assert.deepEqual([await board("days=7"), await board("days=all"), await board("days=99999"), await board("")], [7, null, 730, 30]);
      for (const q of ["limit=999", "limit=-1", "offset=-4", "limit=abc&offset=abc"]) {
        assert.equal((await req(srv.base, "GET", `/api/u/admin/sessions?${q}`)).status, 200, q);
      }
    } finally {
      srv.stop();
    }
  });

  test("admin actions on an unknown user id are 404", async () => {
    const srv = await startServer();
    try {
      assert.equal((await req(srv.base, "POST", "/api/users/99999/enable")).status, 404);
      assert.equal((await req(srv.base, "POST", "/api/users/99999/disable")).status, 404);
      assert.equal((await req(srv.base, "POST", "/api/users/99999/admin", { body: { is_admin: true } })).status, 404);
      assert.equal((await req(srv.base, "POST", "/api/users/99999/password", { body: { password: "long-enough-1" } })).status, 404);
    } finally {
      srv.stop();
    }
  });

  test("CLI: user list and gen-key --user", async () => {
    const srv = await startServer();
    try {
      assert.equal((await userCli(srv.dbPath, ["add", "carol", "--name", "Carol"], "carol-password")).code, 0);
      const list = await userCli(srv.dbPath, ["list"]);
      assert.equal(list.code, 0);
      assert.match(list.out, /#1 admin \(admin\)/);
      assert.match(list.out, /#\d+ carol\n/);
      const key = await genKey(srv.dbPath, "carol-laptop", "--user", "carol");
      assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event() })).json.stored, true);
      assert.equal((await req(srv.base, "GET", "/api/u/carol/stats?days=730", { anon: true })).json.events, 1);
      await assert.rejects(genKey(srv.dbPath, "x", "--user", "nobody"), /no user "nobody"/);
    } finally {
      srv.stop();
    }
  });
});

describe("migrations", () => {
  test("leftovers of removed features are dropped, measured data kept", async () => {
    const dir = fs.mkdtempSync(`${os.tmpdir()}/ai-usage-legacy-`);
    const dbPath = `${dir}/t.db`;
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL);
      CREATE TABLE devices (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL DEFAULT '', revoked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL);
      CREATE TABLE usage_events (event_id TEXT PRIMARY KEY, device_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        tool TEXT NOT NULL, session_id TEXT, prompt_id TEXT, model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_estimated_usd REAL, occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL);
      CREATE TABLE billing_records (id INTEGER PRIMARY KEY);
      CREATE TABLE subscriptions (id INTEGER PRIMARY KEY);
      CREATE TABLE invites (id INTEGER PRIMARY KEY);
      CREATE TABLE app_settings (key TEXT PRIMARY KEY);
      INSERT INTO users (id, created_at) VALUES (1, 0);
      INSERT INTO devices (user_id, name, key_hash, created_at) VALUES (1, 'old', 'h', 0);
      INSERT INTO usage_events (event_id, device_id, user_id, tool, input_tokens, cost_estimated_usd, occurred_at, received_at)
        VALUES ('e1', 1, 1, 'claude-code', 42, 0.1, 0, 0);
    `);
    old.close();
    const srv = await startServer({ env: { DB_PATH: dbPath }, autoLogin: false });
    await srv.stop();
    const db = new Database(dbPath, { readonly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
      for (const t of ["billing_records", "subscriptions", "invites", "app_settings"]) assert.ok(!tables.includes(t), t);
      const cols = db.prepare("PRAGMA table_info(usage_events)").all().map((c) => c.name);
      assert.ok(!cols.includes("cost_estimated_usd"));
      assert.equal(db.prepare("SELECT input_tokens FROM usage_events WHERE event_id = 'e1'").get().input_tokens, 42);
      // Rows from before per-message ingestion are snapshot rows: messages of
      // their session replace them (see "messages replace … snapshot rows").
      assert.equal(db.prepare("SELECT source FROM usage_events WHERE event_id = 'e1'").get().source, "snapshot");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
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
