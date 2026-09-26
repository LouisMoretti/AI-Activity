// Synthetic wire fixtures for the independently observed Antigravity SQLite
// layout; runs the actual Python collector against the actual ingestion API.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import http from "node:http";
import { startServer, req, newDevice } from "./helpers.js";

const SCRIPT = fileURLToPath(new URL("../collectors/antigravity.py", import.meta.url));
const varint = (n) => {
  const out = [];
  do { out.push((n & 127) | (n >= 128 ? 128 : 0)); n = Math.floor(n / 128); } while (n);
  return Buffer.from(out);
};
const integer = (key, n) => Buffer.concat([varint(key * 8), varint(n)]);
const bytes = (key, value) => {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint(key * 8 + 2), varint(b.length), b]);
};
const stamp = (when) => integer(1, when);
const WHEN = Math.floor(Date.now() / 1000) - 3600;
function generation(id, { output = 20, model = "gemini-test", when = WHEN, step = "step1", bot = "bot1" } = {}) {
  const usage = Buffer.concat([integer(1, 10), integer(2, 100), integer(5, 500), integer(9, output),
    integer(10, 30), bytes(11, id), bytes(7, bot)]);
  return Buffer.concat([bytes(1, Buffer.concat([bytes(4, usage), ...(model ? [bytes(19, model)] : []),
    ...(when ? [bytes(9, bytes(4, stamp(when)))] : [])])), bytes(4, step)]);
}
const run = (env, args = [], input = "", command = null) => new Promise((resolve, reject) => {
  const p = spawn(command || process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"), command ? [] : [SCRIPT, ...args],
    { env: { ...process.env, ...env }, shell: !!command, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.on("data", (b) => out += b); p.stderr.on("data", (b) => err += b);
  p.on("error", reject); p.on("close", (code) => resolve({ code, out, err })); p.stdin.end(input);
});

describe("Antigravity collector", () => {
  let srv, key, home, db, env;
  const summary = async () => (await req(srv.base, "GET", "/api/u/admin/summary?tool=antigravity")).json.total;
  const statePath = () => path.join(home, ".cache", "ai-activity", "antigravity.json");
  const put = (idx, blob) => db.prepare("INSERT INTO gen_metadata VALUES (?, ?) ON CONFLICT(idx) DO UPDATE SET data=excluded.data").run(idx, blob);
  before(async () => {
    srv = await startServer(); key = (await newDevice(srv.base)).key;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-activity-antigravity-"));
    const dir = path.join(home, ".gemini", "antigravity-cli", "conversations");
    fs.mkdirSync(dir, { recursive: true });
    db = new Database(path.join(dir, "conversation1.db"));
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY, metadata BLOB); CREATE TABLE secret_prompt(text TEXT)");
    db.prepare("INSERT INTO secret_prompt VALUES (?)").run("PRIVATE PROMPT MUST NEVER LEAVE DEVICE");
    env = { HOME: home, USERPROFILE: home, GEMINI_CLI_HOME: path.join(home, ".gemini"), AI_ACTIVITY_URL: srv.base, AI_ACTIVITY_KEY: key };
    put(1, generation("response1"));
    put(2, generation("response2", { model: null, when: null, step: "step2", bot: "bot2" }));
    db.prepare("INSERT INTO steps VALUES (1, ?)").run(Buffer.concat([bytes(1, stamp(WHEN + 60)), bytes(12, "step2"), bytes(9, bytes(7, "bot2"))]));
  });
  after(() => { db.close(); srv.stop(); fs.rmSync(home, { recursive: true, force: true }); });

  test("imports usage, thinking and cache once, with original timestamps and unknown model preserved", async () => {
    assert.equal((await run(env)).code, 0);
    const t = await summary(); assert.equal(t.tokens, 1320); assert.equal(t.events, 2); assert.equal(t.sessions, 1);
    const stats = (await req(srv.base, "GET", "/api/u/admin/stats?tool=antigravity&days=730")).json;
    assert.equal(stats.input_tokens, 220); assert.equal(stats.output_tokens, 100); assert.equal(stats.cache_read, 1000);
    const sessions = (await req(srv.base, "GET", "/api/u/admin/sessions?tool=antigravity")).json.sessions;
    assert.equal(sessions[0].session_id, "antigravity:conversation1"); assert.equal(sessions[0].last_seen, WHEN + 60);
    assert.equal(sessions[0].context_used_pct, null);
    const saved = fs.readFileSync(statePath(), "utf8");
    assert.ok(!saved.includes(key)); assert.ok(!saved.includes("PRIVATE PROMPT"));
    assert.equal((await run(env)).code, 0); assert.equal((await summary()).tokens, t.tokens);
    fs.unlinkSync(statePath()); assert.equal((await run(env)).code, 0); assert.equal((await summary()).events, 2);
    // Windows requires a byte-range lock; repeated runs must not append bytes.
    assert.ok(fs.statSync(path.join(home, ".cache", "ai-activity", "antigravity.lock")).size <= 1);
  });

  test("partial generations get final counts, and replay cannot double count", async () => {
    put(1, generation("response1", { output: 40 }));
    assert.equal((await run(env)).code, 0); assert.equal((await summary()).tokens, 1340);
    assert.equal((await summary()).events, 2);
  });

  test("failed uploads retain checkpoints; next run sends backlog", async () => {
    put(3, generation("response3"));
    const prior = fs.readFileSync(statePath(), "utf8");
    const badKey = { ...env, AI_ACTIVITY_KEY: "ak_invalid" };
    assert.equal((await run(badKey)).code, 1);
    assert.equal(fs.readFileSync(statePath(), "utf8"), prior);
    assert.equal((await run(env)).code, 0); assert.equal((await summary()).events, 3);
  });

  test("unknown timestamp and corrupt protobuf are skipped, never assigned import time", async () => {
    put(4, generation("response4", { when: null, step: "missing", bot: "missing" }));
    put(5, Buffer.from([10, 255]));
    const r = await run(env); assert.equal(r.code, 0); assert.match(r.err, /unavailable/);
    assert.equal((await summary()).events, 3);
    const prior = fs.readFileSync(statePath(), "utf8");
    assert.equal((await run(env)).code, 0);
    assert.equal(fs.readFileSync(statePath(), "utf8"), prior);
    put(4, generation("response4")); db.prepare("DELETE FROM gen_metadata WHERE idx=5").run();
    assert.equal((await run(env)).code, 0); assert.equal((await summary()).events, 4);
  });

  test("unreadable databases still report failure without discarding accepted checkpoints", async () => {
    const broken = path.join(home, ".gemini", "antigravity-cli", "conversations", "broken.db");
    const prior = fs.readFileSync(statePath(), "utf8");
    fs.writeFileSync(broken, "not a SQLite database");
    try {
      const r = await run(env); assert.equal(r.code, 1); assert.match(r.err, /collection\/upload failed/);
      assert.equal(fs.readFileSync(statePath(), "utf8"), prior);
    } finally { fs.unlinkSync(broken); }
    assert.equal((await run(env)).code, 0);
  });

  test("API separates Antigravity ids from other tools and rejects unsupported identities", async () => {
    const body = { messages: [{ response_id: "bad:id", session_id: "abc", usage: { input_tokens: 100 } }] };
    assert.equal((await req(srv.base, "POST", "/api/ingest/antigravity", { body, key })).json.messages, 0);
    const quotas = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas;
    assert.ok(!quotas.some(q => q.tool === "antigravity"));
  });

  test("ambiguous step matches stay unavailable instead of moving usage to the wrong date", async () => {
    put(6, generation("ambiguous1", { when: null, step: "step2", bot: "bot2" }));
    const r = await run(env); assert.equal(r.code, 0); assert.match(r.err, /unavailable/);
    assert.equal((await summary()).events, 4);
    db.prepare("DELETE FROM gen_metadata WHERE idx=6").run();
  });

  test("only allowlisted metrics cross the network; destination changes replay history", async () => {
    const bodies = [];
    const proxy = http.createServer(async (request, response) => {
      let body = ""; for await (const b of request) body += b;
      const payload = JSON.parse(body); bodies.push(payload);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, messages: payload.messages.length }));
    });
    await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
    try {
      assert.equal((await run({ ...env, AI_ACTIVITY_URL: `http://127.0.0.1:${proxy.address().port}` })).code, 0);
      assert.equal(bodies.flatMap(b => b.messages).length, 4);
      for (const entry of bodies.flatMap(b => b.messages)) {
        assert.deepEqual(Object.keys(entry).sort(), ["model", "occurred_at", "response_id", "session_id", "usage", "utc_offset_min"]);
        assert.deepEqual(Object.keys(entry.usage).sort(), ["cache_read_tokens", "input_tokens", "output_tokens"]);
      }
      assert.ok(!JSON.stringify(bodies).includes("PRIVATE PROMPT"));
      assert.ok(!JSON.stringify(bodies).includes(home));
      assert.equal((await run(env)).code, 0); assert.equal((await summary()).events, 4);
    } finally { await new Promise(resolve => proxy.close(resolve)); }
  });

  test("documented hooks return promptly and automatically import persisted updates", async () => {
    const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8").replaceAll("\r\n", "\n");
    const section = readme.split("## Send Antigravity usage from a device")[1].split("## Send OpenCode")[0];
    const configs = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1])["ai-activity"]);
    assert.equal(configs.length, 2);
    for (const config of configs) {
      assert.equal(config.enabled, true);
      assert.ok(config.PostInvocation[0].command.endsWith(" --post-invocation"));
      assert.ok(config.Stop[0].command.endsWith(" --hook"));
    }
    const windows = process.platform === "win32";
    const config = configs[windows ? 1 : 0];
    const copy = path.join(home, "collector with spaces.py"); fs.copyFileSync(SCRIPT, copy);
    const python = process.env.PYTHON || (windows ? "python" : "python3");
    const quote = s => windows ? `"${s}"` : `'${s.replaceAll("'", "'\\''")}'`;
    const prefix = windows ? 'python "C:\\Users\\<user>\\.gemini\\ai-activity-antigravity.py"' : "python3 ~/.gemini/ai-activity-antigravity.py";
    for (const [event, output] of [["PostInvocation", 60], ["Stop", 80]]) {
      const documented = config[event][0].command;
      assert.ok(documented.startsWith(prefix));
      const command = documented.replace(prefix, `${quote(python)} ${quote(copy)}`);
      const start = Date.now();
      const r = await run(env, [], '{"transcriptPath":"secret/path","conversationId":"conversation1"}', command);
      assert.equal(r.code, 0); assert.deepEqual(JSON.parse(r.out), event === "Stop" ? { decision: "stop" } : {});
      assert.ok(!r.out.includes("secret")); assert.ok(Date.now() - start < 2000, "hook must return before worker delay");
      // Simulate the app persisting final metadata just after the hook returns.
      put(1, generation("response1", { output }));
      let tokens = 0;
      for (let i = 0; i < 30; i++) {
        tokens = (await summary()).tokens;
        if (tokens === 2620 + output) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.equal(tokens, 2620 + output); assert.equal((await summary()).events, 4);
    }
  });
});
