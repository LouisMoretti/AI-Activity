import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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
  const progress = () => JSON.parse(fs.readFileSync(path.join(home, ".cache", "ai-activity", "cursor.json"))).targets;
  const journal = () => path.join(home, ".cache", "ai-activity", "cursor-events");

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
    assert.ok(await waitFor(() => fs.existsSync(path.join(home, ".cache", "ai-activity", "cursor.json"))));
    server.removeAllListeners("request"); server.on("request", handler);
    const files = fs.readdirSync(journal());
    assert.equal(files.length, 1);
    const event = JSON.parse(fs.readFileSync(path.join(journal(), files[0])));
    assert.ok(event.occurred_at >= Math.floor(started/1000)-1);
    assert.equal(event.model, fixture.model);
    assert.equal(event.utc_offset_min % 15, 0);
    assert.equal(captured[0].url, "/api/ingest/cursor");
    assert.equal(captured[0].auth, "Bearer ak_fixture");
    assert.equal(captured[0].body.collector.version, 1);
    assert.ok(!JSON.stringify(captured[0].body).includes("PRIVATE_"));
    for (const file of files) {
      assert.ok(!fs.readFileSync(path.join(journal(), file), "utf8").includes("PRIVATE_"));
      if (process.platform !== "win32") assert.equal(fs.statSync(path.join(journal(), file)).mode & 0o777, 0o600);
    }
    assert.ok(!JSON.stringify(progress()).includes("ak_fixture"));
  });

  test("replays are quiet, partial/final keeps original time and does not lower counts", async () => {
    const original = JSON.parse(fs.readFileSync(path.join(journal(), fs.readdirSync(journal())[0])));
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
    const accepted = JSON.stringify(progress()[collectorTarget(base, "ak_fixture")].accepted);
    mode = 429;
    assert.equal((await run([], env)).code, 1);
    assert.equal(JSON.stringify(progress()[collectorTarget(base, "ak_fixture")].accepted), accepted);
    const count = captured.length;
    assert.equal((await run([], env)).code, 0);
    assert.equal(captured.length, count);
    await new Promise(r => setTimeout(r, 1100));
    mode = 200;
    assert.equal((await run([], env)).code, 0);
    assert.equal(captured.at(-1).body.messages[0].occurred_at, Date.parse("2026-09-25T23:30:00Z")/1000);
  });

  test("new targets resend retained history; malformed and missing usage are skipped", async () => {
    const before = fs.readdirSync(journal()).length;
    for (const payload of [{ ...fixture, input_tokens: undefined }, { ...fixture, output_tokens: "80" },
      { ...fixture, generation_id: "../invalid" }, { ...fixture, hook_event_name: "subagentStop" },
      { ...fixture, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }]) record(payload, env);
    assert.equal(fs.readdirSync(journal()).length, before);
    const newer = { ...env, AI_ACTIVITY_KEY: "ak_new" };
    assert.equal((await run([], newer)).code, 0);
    assert.equal(captured.at(-1).body.messages.length, before);
    assert.equal(captured.at(-1).auth, "Bearer ak_new");
    const result = await run(["--hook"], env, '{"text":"PRIVATE_SECRET"');
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "{}");
    assert.ok(!result.stderr.includes("PRIVATE_SECRET"));
  });
});
