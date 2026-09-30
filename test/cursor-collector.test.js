import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PYTHON, tempHome, collectorTarget, startServer, newDevice, req, collector, register } from "./helpers.js";

const script = fileURLToPath(new URL("../collectors/cursor.py", import.meta.url));
const fixture = JSON.parse(fs.readFileSync(new URL("fixtures/cursor-after-agent-response.json", import.meta.url)));
const waitFor = async (fn) => {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
};
const run = (args, env, stdin = "") => new Promise(resolve => {
  const child = spawn(PYTHON, [script, ...args], { env: { ...process.env, ...env }, windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", c => stdout += c);
  child.stderr.on("data", c => stderr += c);
  child.stdin.end(stdin);
  child.on("exit", code => resolve({ code, stdout, stderr }));
});
const record = (payload, env) => execFileSync(PYTHON, ["-c", `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("cursor",sys.argv[1])
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.record(json.loads(sys.stdin.read()))
`, script], { input: JSON.stringify(payload), env: { ...process.env, ...env }, windowsHide: true });

describe("Cursor ingestion", () => {
  let srv, key;
  const entry = (over = {}) => ({ conversation_id: "c1", generation_id: "g1", model: "composer-2.5",
    occurred_at: Math.floor(Date.now()/1000), utc_offset_min: -240,
    usage: { input_tokens: 1000, output_tokens: 80, cache_read_tokens: 600, cache_write_tokens: 100 }, ...over });
  const post = (body, deviceKey = key) => req(srv.base, "POST", "/api/ingest/cursor", { key: deviceKey, body: { collector: collector("cursor"), ...body } });
  const summary = async () => (await req(srv.base, "GET", "/api/u/admin/summary?tool=cursor")).json.total;
  before(async () => { srv = await startServer(); key = (await newDevice(srv.base, "cursor")).key; });
  after(() => srv.stop());

  test("cache is disjoint, generations deduplicate and final counts replace partial ones", async () => {
    const partial = entry({ usage: { input_tokens: 1000, output_tokens: 10, cache_read_tokens: 600, cache_write_tokens: 100 } });
    const first = await post(partial);
    assert.equal(first.status, 200);
    assert.equal(first.json.event_id, "cursor:c1:g1");
    assert.equal(first.json.stored, true);
    assert.equal((await post({ messages: [partial, partial] })).json.deduped, 2);
    assert.equal((await summary()).tokens, 1010);
    assert.equal((await post(entry())).json.updated, true);
    assert.equal((await post(partial)).json.deduped, true);
    const stats = (await req(srv.base, "GET", "/api/u/admin/stats?tool=cursor")).json;
    assert.equal(stats.input_tokens, 300);
    assert.equal(stats.cache_read, 600);
    assert.equal(stats.cache_write, 100);
    assert.equal(stats.output_tokens, 80);
    assert.equal(stats.total_tokens, 1080);
    const sessions = (await req(srv.base, "GET", "/api/u/admin/sessions?tool=cursor")).json.sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].session_id, "cursor:c1");
    assert.equal(sessions[0].model, "composer-2.5");
    const days = (await req(srv.base, "GET", "/api/u/admin/activity?tool=cursor")).json.days;
    assert.equal(days.at(-1).tokens, 1080);
  });

  test("ids cannot collide with other conversations, tools, or overwrite another account", async () => {
    assert.equal((await post(entry({ conversation_id: "c2" }))).json.stored, true);
    const claude = await req(srv.base, "POST", "/api/ingest/claude-code", { key,
      body: { collector: collector("claude-code"), event_id: "msg_g1", session_id: "c1", usage: { input_tokens: 1, output_tokens: 1 } } });
    assert.equal(claude.json.stored, true);
    const other = await register(srv.base, "cursor-other");
    const device = await newDevice(srv.base, "other-cursor", other.cookie);
    assert.equal((await post(entry({ usage: { input_tokens: 9999, output_tokens: 9999,
      cache_read_tokens: 0, cache_write_tokens: 0 } }), device.key)).json.deduped, true);
    assert.equal((await summary()).tokens, 2160);
    const global = (await req(srv.base, "GET", "/api/leaderboard?days=all")).json;
    assert.ok(global.by_model.some(m => m.name === "composer-2.5" && m.tokens === 2160));
  });

  test("id and model fallbacks store; invalid cache conventions and unsafe totals are skipped", async () => {
    const at = Math.floor(Date.now()/1000);
    const camel = { session_id: "s9", generation_id: "g9", model_id: "custom-model", occurred_at: at, utc_offset_min: 9999,
      usage: { inputTokens: 1000, outputTokens: 80, cacheReadTokens: 600, cacheWriteTokens: 100 } };
    assert.equal((await post({ messages: [camel] })).json.stored, 1);
    const over = { conversation_id: "c10", generation_id: "g10", occurred_at: at,
      usage: { input_tokens: 100, output_tokens: 80, cache_read_tokens: 600, cache_write_tokens: 100 } };
    const beforeInvalid = (await req(srv.base, "GET", "/api/u/admin/stats?tool=cursor")).json;
    assert.equal((await post({ messages: [over] })).json.stored, 0);
    const stats = (await req(srv.base, "GET", "/api/u/admin/stats?tool=cursor")).json;
    const models = (await req(srv.base, "GET", "/api/u/admin/summary?tool=cursor")).json.total.by_model;
    assert.ok(models.some((m) => m.name === "custom-model"));
    assert.equal(stats.total_tokens, beforeInvalid.total_tokens, "invalid cache counters never invent totals");
    for (const over2 of [{ usage: { input_tokens: 80.9, output_tokens: 80, cache_read_tokens: 0, cache_write_tokens: 0 } },
      { conversation_id: "", session_id: "s9" }, { occurred_at: -1 }, { occurred_at: true },
      { usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 } }]) {
      assert.equal((await post({ messages: [entry(over2)] })).json.stored, 0);
    }
  });

  test("ignores unknown ids, zero usage, context, quotas and mismatched tool payloads", async () => {
    for (const over of [{ generation_id: "" }, { conversation_id: "bad:id" }, { generation_id: null },
      { usage: {} }, { usage: { input_tokens: 5, output_tokens: 5 } }]) {
      assert.equal((await post({ messages: [entry(over)] })).json.stored, 0);
    }
    await post({ messages: [], context: { session_id: "c1", used_pct: 50 },
      rate_limits: { five_hour: { used_percentage: 42, resets_at: Math.floor(Date.now()/1000)+3600 } } });
    assert.deepEqual((await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas.filter(q => q.tool === "cursor"), []);
    assert.equal((await post({ tool: "codex" })).status, 400);
    assert.equal((await post({}, "ak_unknown")).status, 401);
  });
});

describe("Cursor hook collector", () => {
  let home, env, server, base, captured = [], mode = 200;
  before(async () => {
    home = tempHome("ai-activity-cursor-");
    server = http.createServer(async (q, res) => {
      let body = ""; for await (const c of q) body += c;
      captured.push({ url: q.url, auth: q.headers.authorization, body: JSON.parse(body) });
      res.writeHead(mode, { "content-type": "application/json", "retry-after": "1" });
      res.end(JSON.stringify(mode === 200 ? { ok: true } : { error: "retry" }));
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
    env = { HOME: home, USERPROFILE: home, AI_ACTIVITY_URL: base, AI_ACTIVITY_KEY: "ak_fixture" };
  });
  after(async () => { await new Promise(r => server.close(r)); fs.rmSync(home, { recursive: true, force: true }); });
  const database = () => path.join(home, ".cache", "ai-activity", "cursor.db");
  const readDB = (sql) => {
    const db = new Database(database(), { readonly: true });
    try { return db.prepare(sql).all(); } finally { db.close(); }
  };
  const events = () => readDB("SELECT payload FROM events ORDER BY revision").map(r => JSON.parse(r.payload));
  const progress = () => Object.fromEntries(readDB("SELECT fingerprint, revision, retry_at FROM targets").map(r => [r.fingerprint, r]));

  test("answers before a slow upload finishes, keeps only metrics and preserves time", async () => {
    // Slow network response proves the hook itself never waits for an upload.
    const handler = server.listeners("request")[0];
    server.removeAllListeners("request");
    server.on("request", (q, res) => setTimeout(() => handler(q, res), 1500));
    const started = Date.now();
    const result = await run(["--hook"], env, JSON.stringify(fixture));
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "{}");
    assert.ok(Date.now() - started < 1300, "hook returned before the server responded");
    assert.ok(await waitFor(() => fs.existsSync(database()) && progress()[collectorTarget(base, "ak_fixture")]?.revision > 0));
    server.removeAllListeners("request"); server.on("request", handler);
    assert.equal(events().length, 1);
    const event = events()[0];
    assert.ok(event.occurred_at >= Math.floor(started/1000)-1);
    assert.equal(event.model, fixture.model);
    assert.equal(event.utc_offset_min % 15, 0);
    assert.equal(captured[0].url, "/api/ingest/cursor");
    assert.equal(captured[0].auth, "Bearer ak_fixture");
    assert.equal(captured[0].body.collector.version, 4);
    assert.ok(!JSON.stringify(captured[0].body).includes("PRIVATE_"));
    assert.ok(!JSON.stringify(events()).includes("PRIVATE_"));
    assert.ok(!fs.readFileSync(database()).includes(Buffer.from("PRIVATE_")));
    if (process.platform !== "win32") assert.equal(fs.statSync(database()).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(progress()).includes("ak_fixture"));
  });

  test("replays are quiet, partial/final keeps original time and does not lower counts", async () => {
    const original = events()[0];
    const before = captured.length;
    record({ ...fixture, hook_event_name: "stop" }, env);
    assert.equal((await run([], env)).code, 0);
    assert.equal(captured.length, before);
    record({ ...fixture, output_tokens: 100, timestamp: "2026-01-01T01:01:01Z" }, env);
    record(fixture, env);
    assert.equal((await run([], env)).code, 0);
    assert.equal(captured.length, before+1);
    assert.equal(captured.at(-1).body.messages[0].usage.output_tokens, 100);
    assert.equal(captured.at(-1).body.messages[0].occurred_at, original.occurred_at);
  });

  test("refused uploads keep the queue, respect Retry-After and retry with original timestamps", async () => {
    record({ ...fixture, generation_id: "offline", timestamp: "2026-09-25T23:30:00Z" }, env);
    const accepted = progress()[collectorTarget(base, "ak_fixture")].revision;
    mode = 429;
    assert.equal((await run([], env)).code, 1);
    assert.equal(progress()[collectorTarget(base, "ak_fixture")].revision, accepted);
    const count = captured.length;
    assert.equal((await run([], env)).code, 0);
    assert.equal(captured.length, count);
    await new Promise(r => setTimeout(r, 1100));
    mode = 200;
    assert.equal((await run([], env)).code, 0);
    assert.equal(captured.at(-1).body.messages[0].occurred_at, Date.parse("2026-09-25T23:30:00Z")/1000);
  });

  test("new targets resend retained history; malformed and missing usage are skipped", async () => {
    const before = events().length;
    for (const payload of [{ ...fixture, input_tokens: undefined }, { ...fixture, input_tokens: 80.9 },
      { ...fixture, input_tokens: 10 }, { ...fixture, input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }, { ...fixture, output_tokens: "80" },
      { ...fixture, generation_id: "../invalid" }, { ...fixture, hook_event_name: "subagentStop" },
      { ...fixture, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }]) record(payload, env);
    assert.equal(events().length, before);
    const newer = { ...env, AI_ACTIVITY_KEY: "ak_new" };
    assert.equal((await run([], newer)).code, 0);
    assert.equal(captured.at(-1).body.messages.length, before);
    assert.equal(captured.at(-1).auth, "Bearer ak_new");
    const result = await run(["--hook"], env, '{"text":"PRIVATE_SECRET"');
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "{}");
    assert.ok(!result.stderr.includes("PRIVATE_SECRET"));
  });

  test("numeric timestamps, id fallbacks and corrupt files", async () => {
    mode = 200; // independent of the retry test above, wherever it got to
    const at = 1790280600; // 2026-09-25T23:30:00Z
    const read = (gen) => events().find(e => e.generation_id === gen);
    record({ ...fixture, conversation_id: "num-epoch", generation_id: "g-num", timestamp: at }, env);
    record({ ...fixture, conversation_id: "num-float", generation_id: "g-float", timestamp: at + 0.9 }, env);
    record({ ...fixture, conversation_id: "num-ms", generation_id: "g-ms", timestamp: at * 1000 }, env);
    assert.equal(read("g-num").occurred_at, at);
    assert.equal(read("g-float").occurred_at, at);
    assert.equal(read("g-ms").occurred_at, at);
    const { conversation_id: _drop, ...noConv } = fixture;
    record({ ...noConv, session_id: "sess-fallback", generation_id: "g-sess", model_id: "model-x",
      inputTokens: 1000, outputTokens: 80, cacheReadTokens: 600, cacheWriteTokens: 100 }, env);
    const fell = read("g-sess");
    assert.equal(fell.conversation_id, "sess-fallback");
    assert.equal(fell.model, "model-x");
    assert.equal(fell.usage.input_tokens, 1000);
    const before = events().length;
    // An empty conversation_id does not fall back (like the server); booleans are not epochs.
    record({ ...fixture, conversation_id: "", session_id: "sess-fallback", generation_id: "g-empty" }, env);
    record({ ...fixture, conversation_id: "num-bool", generation_id: "g-bool", timestamp: true }, env);
    assert.equal(events().length, before);
    // A valid JSON row with invalid metrics cannot poison an entire batch.
    const db = new Database(database());
    const poisoned = db.prepare("SELECT identity FROM events LIMIT 1").get().identity;
    db.prepare("UPDATE events SET payload = ? WHERE identity = ?").run('{"text":"PRIVATE_SECRET"}', poisoned);
    db.prepare("UPDATE targets SET revision = 0").run();
    db.close();
    const result = await run([], env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /skipping corrupt metrics/);
    record({ ...fixture, conversation_id: "num-after", generation_id: "g-after" }, env);
    assert.ok(read("g-after"));
    assert.equal((await run([], env)).code, 0);
    assert.ok(!JSON.stringify(captured.at(-1)).includes("PRIVATE_SECRET"));
  });

  test("simultaneous first hooks and final updates retain every turn once", async () => {
    const h = tempHome("ai-activity-cursor-race-");
    const e = { ...env, HOME: h, USERPROFILE: h };
    try {
      const code = `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("cursor",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.record(json.loads(sys.stdin.read()))
`;
      const children = Array.from({ length: 12 }, (_, i) => new Promise((resolve, reject) => {
        const child = spawn(PYTHON, ["-c", code, script], { env: { ...process.env, ...e }, windowsHide: true });
        let stderr = "";
        child.stderr.on("data", c => stderr += c);
        child.on("error", reject);
        child.on("close", code => resolve({ code, stderr }));
        child.stdin.end(JSON.stringify({ ...fixture, generation_id: `race-${i}`, output_tokens: 100+i }));
      }));
      for (const result of await Promise.all(children)) assert.equal(result.code, 0, result.stderr);
      const before = captured.length;
      assert.equal((await run([], e)).code, 0);
      assert.equal(captured[before].body.messages.length, 12);
      assert.equal(new Set(captured[before].body.messages.map(m => m.generation_id)).size, 12);
      const db = new Database(path.join(h, ".cache", "ai-activity", "cursor.db"));
      assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
      db.close();
    } finally { fs.rmSync(h, { recursive: true, force: true }); }
  });

  test("an update arriving during an upload is sent again without holding a write lock", async () => {
    const h = tempHome("ai-activity-cursor-during-");
    const e = { ...env, HOME: h, USERPROFILE: h };
    const handler = server.listeners("request")[0];
    const before = captured.length;
    try {
      record({ ...fixture, output_tokens: 81 }, e);
      let changed = false;
      server.removeAllListeners("request");
      server.on("request", (q, res) => {
        if (!changed) { changed = true; record({ ...fixture, output_tokens: 99 }, e); }
        handler(q, res);
      });
      const result = await run([], e);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(captured.slice(before).map(r => r.body.messages[0].usage.output_tokens), [81, 99]);
      assert.equal(captured[before].body.messages[0].occurred_at, captured[before+1].body.messages[0].occurred_at);
    } finally {
      server.removeAllListeners("request"); server.on("request", handler);
      fs.rmSync(h, { recursive: true, force: true });
    }
  });

  test("migrates legacy metrics with original days, quarantines corruption and safely replays", async () => {
    const h = tempHome("ai-activity-cursor-legacy-");
    const e = { ...env, HOME: h, USERPROFILE: h };
    const cache = path.join(h, ".cache", "ai-activity");
    try {
      execFileSync(PYTHON, ["-c", `
import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location("cursor",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
os.makedirs(m.JOURNAL)
event=m.metric_event(json.loads(sys.stdin.read()))
event["utc_offset_min"]=345
event["text"]="PRIVATE_DO_NOT_MIGRATE"
with open(os.path.join(m.JOURNAL,m.identity(event)+".json"),"w") as f: json.dump(event,f)
with open(os.path.join(m.JOURNAL,"f"*64+".json"),"w") as f: f.write("{corrupt")
with open(os.path.join(m.JOURNAL,"e"*64+".json"),"w") as f: f.write("["*2000+"0"+"]"*2000)
with open(os.path.join(m.CACHE,"cursor.json"),"w") as f: f.write("{corrupt")
`, script], { env: { ...process.env, ...e }, input: JSON.stringify({ ...fixture, timestamp: "2026-01-01T01:01:01Z" }), windowsHide: true });
      // A newer final hook before the first migration preserves the old time.
      record({ ...fixture, output_tokens: 100 }, e);
      const before = captured.length;
      const result = await run([], e);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stderr, /skipping corrupt legacy metrics/);
      const msg = captured[before].body.messages[0];
      assert.equal(msg.occurred_at, Date.parse("2026-01-01T01:01:01Z")/1000);
      assert.equal(msg.utc_offset_min, 345);
      assert.equal(msg.usage.output_tokens, 100);
      assert.ok(!JSON.stringify(captured[before]).includes("PRIVATE_"));
      assert.deepEqual(fs.readdirSync(path.join(cache, "cursor-events")), []);
      assert.equal(fs.existsSync(path.join(cache, "cursor.json")), false);
      assert.equal(fs.readdirSync(path.join(cache, "cursor-invalid")).length, 2);
      assert.equal((await run([], e)).code, 0);
      assert.equal(captured.length, before+1, "migration and idle refresh never re-upload accepted metrics");
    } finally { fs.rmSync(h, { recursive: true, force: true }); }
  });

  test("large history uses bounded batches, compact target checkpoints and quiet idle runs", async () => {
    const h = tempHome("ai-activity-cursor-backlog-");
    const e = { ...env, HOME: h, USERPROFILE: h };
    try {
      execFileSync(PYTHON, ["-c", `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("cursor",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
payload=json.loads(sys.stdin.read())
with m.journal() as db:
    db.execute("BEGIN IMMEDIATE")
    with db:
        for i in range(625):
            event=m.metric_event(dict(payload,conversation_id="c"*200,generation_id=str(i)+"g"*190,model="🤖"*120))
            m.store_event(db,event)
`, script], { env: { ...process.env, ...e }, input: JSON.stringify(fixture), windowsHide: true });
      const before = captured.length;
      const result = await run([], e);
      assert.equal(result.code, 0, result.stderr);
      const batches = captured.slice(before);
      assert.equal(batches.flatMap(r => r.body.messages).length, 625);
      for (const r of batches) {
        assert.ok(r.body.messages.length <= 200);
        assert.ok(Buffer.byteLength(JSON.stringify(r.body)) < 256*1024);
      }
      const after = captured.length;
      assert.equal((await run([], e)).code, 0);
      assert.equal(captured.length, after);
      assert.equal((await run(["--replay"], e)).code, 0);
      assert.equal(captured.slice(after).flatMap(r => r.body.messages).length, 625);
      for (let i = 0; i < 10; i++) {
        assert.equal((await run([], { ...e, AI_ACTIVITY_KEY: `ak_target_${i}` })).code, 0);
      }
      const db = new Database(path.join(h, ".cache", "ai-activity", "cursor.db"));
      assert.equal(db.prepare("SELECT count(*) n FROM targets").get().n, 8);
      assert.equal(db.prepare("SELECT count(*) n FROM events").get().n, 625);
      const newest = db.prepare("SELECT fingerprint, revision FROM targets ORDER BY used_at DESC LIMIT 1").get();
      assert.equal(newest.fingerprint, collectorTarget(base, "ak_target_9"));
      assert.equal(newest.revision, 625);
      db.close();
    } finally { fs.rmSync(h, { recursive: true, force: true }); }
  });

  test("redirects and invalid acknowledgements keep metrics and stop retry storms", async () => {
    const h = tempHome("ai-activity-cursor-refusal-");
    const e = { ...env, HOME: h, USERPROFILE: h };
    const handler = server.listeners("request")[0];
    let destinationCalls = 0;
    const destination = http.createServer((q, res) => { destinationCalls++; res.end('{"ok":true}'); });
    await new Promise(r => destination.listen(0, "127.0.0.1", r));
    try {
      record(fixture, e);
      server.removeAllListeners("request");
      server.on("request", (q, res) => { q.resume(); res.writeHead(307, { location: `http://127.0.0.1:${destination.address().port}` }); res.end(); });
      assert.equal((await run([], e)).code, 1);
      assert.equal(destinationCalls, 0, "a redirect never gets the device key");
      const db = new Database(path.join(h, ".cache", "ai-activity", "cursor.db"));
      assert.equal(db.prepare("SELECT revision FROM targets").get().revision, 0);
      assert.equal((await run([], e)).code, 0, "backoff suppresses another request");
      db.prepare("UPDATE targets SET retry_at = 0").run();
      server.removeAllListeners("request");
      server.on("request", (q, res) => { q.resume(); res.end('{"ok":false}'); });
      assert.equal((await run([], e)).code, 1);
      assert.equal(db.prepare("SELECT revision FROM targets").get().revision, 0);
      db.prepare("UPDATE targets SET retry_at = 0").run();
      server.removeAllListeners("request"); server.on("request", handler);
      assert.equal((await run([], e)).code, 0);
      assert.equal(db.prepare("SELECT revision FROM targets").get().revision, 1);
      db.close();
    } finally {
      server.removeAllListeners("request"); server.on("request", handler);
      await new Promise(r => destination.close(r));
      fs.rmSync(h, { recursive: true, force: true });
    }
  });

  test("a damaged or newer local database is preserved for recovery", async () => {
    const h = tempHome("ai-activity-cursor-damaged-");
    const e = { ...env, HOME: h, USERPROFILE: h };
    const cache = path.join(h, ".cache", "ai-activity");
    const file = path.join(cache, "cursor.db");
    try {
      fs.mkdirSync(cache, { recursive: true });
      fs.writeFileSync(file, "damaged-database-retain-for-recovery");
      const before = fs.readFileSync(file);
      const hook = await run(["--hook"], e, JSON.stringify(fixture));
      assert.equal(hook.code, 0);
      assert.equal(hook.stdout.trim(), "{}");
      assert.match(hook.stderr, /could not queue metrics \(DatabaseError\)/);
      assert.deepEqual(fs.readFileSync(file), before);
      fs.rmSync(file);
      const db = new Database(file);
      db.exec("CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('history'); PRAGMA user_version = 99");
      db.close();
      const result = await run([], e);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /newer than this collector/);
      const after = new Database(file);
      assert.equal(after.prepare("SELECT value FROM preserved").get().value, "history");
      after.close();
    } finally { fs.rmSync(h, { recursive: true, force: true }); }
  });

  test("clock corrections never re-date retained turns or evict the active target", () => {
    const h = tempHome("ai-activity-cursor-clock-");
    try {
      execFileSync(PYTHON, ["-c", `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("cursor",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
event=m.metric_event(dict(json.loads(sys.stdin.read()),timestamp="2026-01-01T01:01:01Z"))
m.time.time=lambda: 1
assert m.retained_event(event)["occurred_at"] == event["occurred_at"]
with m.journal() as db:
    with db:
        for i in range(8): db.execute("INSERT INTO targets (fingerprint,used_at) VALUES (?,?)",("old%d"%i,1000+i))
    fp,state=m.select_target(db)
    assert fp == m.target() and state == (0,0)
    assert db.execute("SELECT count(*) FROM targets").fetchone()[0] == 8
    assert db.execute("SELECT fingerprint FROM targets ORDER BY used_at DESC LIMIT 1").fetchone()[0] == fp
`, script], { env: { ...process.env, ...env, HOME: h, USERPROFILE: h }, input: JSON.stringify(fixture), windowsHide: true });
    } finally { fs.rmSync(h, { recursive: true, force: true }); }
  });

  test("local schema upgrades preserve both early event layouts and accepted checkpoints", async () => {
    for (const redundant of [false, true]) {
      const h = tempHome("ai-activity-cursor-schema-");
      const e = { ...env, HOME: h, USERPROFILE: h };
      try {
        execFileSync(PYTHON, ["-c", `
import importlib.util,json,sqlite3,sys,os
spec=importlib.util.spec_from_file_location("cursor",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
os.makedirs(m.CACHE)
event=m.metric_event(json.loads(sys.stdin.read()))
extra=", output_tokens INTEGER NOT NULL" if sys.argv[2]=="true" else ""
with sqlite3.connect(m.DATABASE) as db:
    db.execute("CREATE TABLE events (identity TEXT PRIMARY KEY,revision INTEGER NOT NULL UNIQUE,payload TEXT NOT NULL"+extra+")")
    db.execute("CREATE TABLE targets (fingerprint TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,retry_at REAL NOT NULL DEFAULT 0,used_at REAL NOT NULL)")
    db.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY,value INTEGER NOT NULL)")
    db.execute("INSERT INTO metadata VALUES ('revision',1),('legacy_migrated',1)")
    values=[m.identity(event),1,json.dumps(event)] + ([event["usage"]["output_tokens"]] if extra else [])
    db.execute("INSERT INTO events VALUES ("+",".join("?" for _ in values)+")",values)
    db.execute("INSERT INTO targets VALUES (?,1,0,1)",(m.target(),))
    db.execute("PRAGMA user_version=1")
`, script, String(redundant)], { env: { ...process.env, ...e }, input: JSON.stringify(fixture), windowsHide: true });
        const before = captured.length;
        assert.equal((await run([], e)).code, 0);
        assert.equal(captured.length, before, "accepted history is not replayed on a schema upgrade");
        const db = new Database(path.join(h, ".cache", "ai-activity", "cursor.db"));
        assert.equal(db.pragma("user_version", { simple: true }), 2);
        assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
        const original = JSON.parse(db.prepare("SELECT payload FROM events").get().payload);
        db.close();
        record({ ...fixture, output_tokens: 120 }, e);
        assert.equal((await run([], e)).code, 0);
        assert.equal(captured.at(-1).body.messages[0].occurred_at, original.occurred_at);
        assert.equal(captured.at(-1).body.messages[0].usage.output_tokens, 120);
      } finally { fs.rmSync(h, { recursive: true, force: true }); }
    }
  });

});
