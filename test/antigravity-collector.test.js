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
const run = (env, args = [], input = "", command = null, script = SCRIPT) => new Promise((resolve, reject) => {
  const p = spawn(command || process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"), command ? [] : [script, ...args],
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

  test("duplicate partial/final response rows upload once and settle across batch boundaries", async () => {
    const batches = [];
    const proxy = http.createServer(async (request, response) => {
      let body = ""; for await (const b of request) body += b;
      const payload = JSON.parse(body); batches.push(payload.messages);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, messages: payload.messages.length }));
    });
    await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
    // The final record precedes these older partial duplicates in row order.
    for (let idx = 20; idx < 221; idx++) put(idx, generation("response1", { output: 20 }));
    const destination = { ...env, AI_ACTIVITY_URL: `http://127.0.0.1:${proxy.address().port}` };
    try {
      assert.equal((await run(destination)).code, 0);
      assert.equal(batches.length, 1); assert.equal(batches[0].length, 2);
      assert.equal(batches[0].find(e => e.response_id === "response1").usage.output_tokens, 70);
      const checkpoint = fs.readFileSync(statePath(), "utf8");
      assert.equal((await run(destination)).code, 0);
      assert.equal(batches.length, 1, "settled duplicates must not create replay traffic");
      assert.equal(fs.readFileSync(statePath(), "utf8"), checkpoint);
    } finally {
      db.prepare("DELETE FROM gen_metadata WHERE idx>=20").run();
      await new Promise(resolve => proxy.close(resolve));
    }
    assert.equal((await run(env)).code, 0); assert.equal((await summary()).tokens, 1340);
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
      assert.deepEqual(JSON.parse(fs.readFileSync(statePath(), "utf8")).sent, JSON.parse(prior).sent);
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

  test("a Stop worker waits for an in-flight upload and collects the final generation without another hook", async () => {
    let release, arrived;
    const gate = new Promise(resolve => release = resolve);
    const firstRequest = new Promise(resolve => arrived = resolve);
    const batches = [];
    const proxy = http.createServer(async (request, response) => {
      let body = ""; for await (const b of request) body += b;
      const payload = JSON.parse(body); batches.push(payload.messages);
      if (batches.length === 1) { arrived(); await gate; }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, messages: payload.messages.length }));
    });
    await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const destination = { ...env, AI_ACTIVITY_URL: `http://127.0.0.1:${proxy.address().port}` };
    put(1, generation("response1", { output: 100 }));
    const first = run(destination);
    try {
      await firstRequest;
      put(1, generation("response1", { output: 140 }));
      assert.equal((await run(destination, ["--hook"], "{}")).code, 0);
      // Allow the detached Stop worker to reach the lock while it is held.
      await new Promise(resolve => setTimeout(resolve, 3000));
      assert.equal(batches.length, 1);
      release(); assert.equal((await first).code, 0);
      for (let i = 0; i < 30 && batches.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(batches.length, 2);
      assert.equal(batches[1].find(e => e.response_id === "response1").usage.output_tokens, 170);
      // A final manual replay also waits for the queued worker to finish.
      assert.equal((await run(destination)).code, 0); assert.equal(batches.length, 2);
    } finally {
      release(); await first;
      await new Promise(resolve => proxy.close(resolve));
    }
  });
});

// Exercise real scan/upload/checkpoint logic with smaller resource budgets.
// No production environment variables can weaken the collector's limits.
async function scanFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-activity-antigravity-budget-"));
  const dir = path.join(home, ".gemini", "antigravity-cli", "conversations");
  fs.mkdirSync(dir, { recursive: true });
  const batches = [], accepted = new Map();
  let refuse = false;
  const proxy = http.createServer(async (request, response) => {
    let body = ""; for await (const b of request) body += b;
    const payload = JSON.parse(body); batches.push(payload.messages);
    response.setHeader("content-type", "application/json");
    if (refuse) { response.statusCode = 503; response.end("{}"); return; }
    for (const e of payload.messages) accepted.set(e.session_id + ":" + e.response_id, e);
    response.end(JSON.stringify({ ok: true, messages: payload.messages.length }));
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const env = { HOME: home, USERPROFILE: home, GEMINI_CLI_HOME: path.join(home, ".gemini"),
    AI_ACTIVITY_URL: `http://127.0.0.1:${proxy.address().port}`, AI_ACTIVITY_KEY: "test-key" };
  const add = (name, records, steps = []) => {
    const db = new Database(path.join(dir, name + ".db"));
    db.exec("CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY, metadata BLOB)");
    for (const [i, blob] of records.entries()) db.prepare("INSERT INTO gen_metadata VALUES (?, ?)").run(i + 1, blob);
    for (const [i, blob] of steps.entries()) db.prepare("INSERT INTO steps VALUES (?, ?)").run(i + 1, blob);
    db.close();
  };
  const state = () => JSON.parse(fs.readFileSync(path.join(home, ".cache", "ai-activity", "antigravity.json"), "utf8"));
  const collect = async (limits, slow = false) => {
    const script = path.join(home, "bounded-test.py");
    fs.writeFileSync(script, `import importlib.util, time\nspec = importlib.util.spec_from_file_location('collector', ${JSON.stringify(SCRIPT)})\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\n` +
      Object.entries(limits).map(([key, value]) => `m.${key} = ${value}\n`).join("") +
      (slow ? "original = m.read_database\ndef slow(*args):\n time.sleep(0.03)\n return original(*args)\nm.read_database = slow\n" : "") +
      "try:\n m.collect()\nexcept Exception:\n raise SystemExit(1)\n");
    return run(env, [], "", null, script);
  };
  return { add, state, collect, accepted, batches, dir, refuse: value => refuse = value,
    close: async () => { await new Promise(resolve => proxy.close(resolve)); fs.rmSync(home, { recursive: true, force: true }); } };
}

test("source-count budgets resume past the previous cursor instead of starving later databases", async () => {
  const f = await scanFixture();
  try {
    for (let i = 0; i < 7; i++) f.add(`conversation${i}`, [generation(`response${i}`)]);
    for (let i = 0; i < 3; i++) assert.equal((await f.collect({ MAX_DATABASES: 3 })).code, 0);
    assert.equal(f.accepted.size, 7);
    const calls = f.batches.length;
    assert.equal((await f.collect({ MAX_DATABASES: 3 })).code, 0); assert.equal(f.batches.length, calls);
  } finally { await f.close(); }
});

test("elapsed-time budgets preserve source progress and eventually import the entire history", async () => {
  const f = await scanFixture();
  try {
    for (let i = 0; i < 3; i++) f.add(`conversation${i}`, [generation(`response${i}`)]);
    for (let i = 0; i < 3; i++) assert.equal((await f.collect({ MAX_RUN_SECONDS: 0.02 }, true)).code, 0);
    assert.equal(f.accepted.size, 3);
  } finally { await f.close(); }
});

test("generation byte pages and streamed step metadata import a large conversation without losing progress", async () => {
  const f = await scanFixture();
  try {
    const padding = bytes(127, Buffer.alloc(400));
    f.add("large", [Buffer.concat([generation("first"), padding]),
      Buffer.concat([generation("matched", { when: null, step: "unique", bot: "unique" }), padding]),
      Buffer.concat([generation("last"), padding])],
    [...Array.from({ length: 20 }, () => bytes(127, Buffer.alloc(1000))),
      Buffer.concat([bytes(1, stamp(WHEN + 60)), bytes(12, "unique"), bytes(9, bytes(7, "unique"))])]);
    const limits = { MAX_PAGE_BYTES: 512 };
    f.refuse(true); assert.equal((await f.collect(limits)).code, 1);
    assert.equal(f.accepted.size, 0); // Refusal cannot advance the page cursor.
    f.refuse(false);
    for (let i = 0; i < 3; i++) assert.equal((await f.collect(limits)).code, 0);
    assert.equal(f.accepted.size, 3);
    assert.equal(f.accepted.get("large:matched").occurred_at, WHEN + 60);
    assert.deepEqual(f.state().positions, {});
    const calls = f.batches.length;
    for (let i = 0; i < 3; i++) assert.equal((await f.collect(limits)).code, 0);
    assert.equal(f.batches.length, calls);
  } finally { await f.close(); }
});

test("row pages neither misdate cross-page ambiguity nor repeatedly replay older duplicate responses", async () => {
  const f = await scanFixture();
  try {
    f.add("paged", [generation("final", { output: 80 }),
      generation("ambiguousA", { when: null, step: "shared", bot: "shared" }),
      generation("final", { output: 20 }),
      generation("ambiguousB", { when: null, step: "shared", bot: "shared" })],
    [Buffer.concat([bytes(1, stamp(WHEN + 60)), bytes(12, "shared"), bytes(9, bytes(7, "shared"))])]);
    const limits = { MAX_ROWS: 2 };
    for (let i = 0; i < 4; i++) assert.equal((await f.collect(limits)).code, 0);
    assert.equal(f.accepted.size, 1); assert.equal(f.batches.length, 1);
    assert.equal(f.accepted.get("paged:final").usage.output_tokens, 110);
  } finally { await f.close(); }
});

test("a time limit between upload batches keeps accepted ranks but does not advance past unsent entries", async () => {
  const f = await scanFixture();
  try {
    f.add("batched", Array.from({ length: 250 }, (_, i) => generation(`response${i}`)));
    const limits = { MAX_RUN_SECONDS: 0 };
    assert.equal((await f.collect(limits)).code, 0); assert.equal(f.accepted.size, 200);
    assert.deepEqual(f.state().positions, {});
    assert.equal((await f.collect(limits)).code, 0); assert.equal(f.accepted.size, 250);
    assert.equal(f.batches.length, 2); assert.equal(f.batches[1].length, 50);
    assert.equal((await f.collect(limits)).code, 0); assert.equal(f.batches.length, 2);
  } finally { await f.close(); }
});

test("an incomplete timestamp scan preserves native dates and retries unresolved matches on a complete scan", async () => {
  const f = await scanFixture();
  try {
    f.add("limited", [generation("native"), generation("matched", { when: null, step: "unique", bot: "unique" })],
      [Buffer.concat([bytes(1, stamp(WHEN + 60)), bytes(12, "unique"), bytes(9, bytes(7, "unique"))])]);
    for (let i = 0; i < 2; i++) assert.equal((await f.collect({ MAX_SCAN_SECONDS: 0 })).code, 0);
    assert.equal(f.accepted.size, 1); assert.equal(f.accepted.get("limited:native").occurred_at, WHEN);
    assert.equal((await f.collect({})).code, 0); assert.equal(f.accepted.size, 2);
    assert.equal(f.accepted.get("limited:matched").occurred_at, WHEN + 60);
  } finally { await f.close(); }
});
