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
    { env: { ...process.env, AI_ACTIVITY_ANTIGRAVITY_QUOTAS: "0", ...env }, shell: !!command, stdio: ["pipe", "pipe", "pipe"] });
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

  test("hook bursts leave one waiter and still collect the final generation", async () => {
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
    const script = path.join(home, "coalesced-worker.py"), scans = path.join(home, "scans.txt");
    fs.writeFileSync(script, `import importlib.util, pathlib\n` +
      `spec = importlib.util.spec_from_file_location('collector', ${JSON.stringify(SCRIPT)})\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\n` +
      `original = m.read_database\ndef scan(*args):\n with pathlib.Path(${JSON.stringify(scans)}).open('a') as log: log.write('scan\\n')\n return original(*args)\nm.read_database = scan\nm.hook_worker()\n`);
    put(1, generation("response1", { output: 180 }));
    const first = run(destination), results = [], workers = [];
    try {
      await firstRequest;
      for (let i = 0; i < 12; i++) workers.push(run(destination, [], "", null, script).then(r => { results.push(r); return r; }));
      for (let i = 0; i < 50 && results.length < 11; i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(results.length, 11, "all but one waiter exit without scanning");
      assert.ok(results.every(r => r.code === 0)); assert.ok(!fs.existsSync(scans));
      put(1, generation("response1", { output: 220 }));
      release(); assert.equal((await first).code, 0);
      assert.ok((await Promise.all(workers)).every(r => r.code === 0));
      assert.equal(fs.readFileSync(scans, "utf8").replaceAll("\r\n", "\n"), "scan\n");
      assert.equal(batches.length, 2);
      assert.equal(batches[1].find(e => e.response_id === "response1").usage.output_tokens, 250);
      // Released queue locks remain reusable on the next hook.
      assert.equal((await run(destination, [], "", null, script)).code, 0);
      assert.equal(fs.readFileSync(scans, "utf8").replaceAll("\r\n", "\n"), "scan\n", "an unchanged hook reuses the completed stamp");
    } finally {
      release(); await first; await Promise.all(workers);
      await new Promise(resolve => proxy.close(resolve));
    }
  });

  test("a worker launch failure preserves both hook response contracts", async () => {
    const script = path.join(home, "launch-failure.py");
    for (const flag of ["--hook", "--post-invocation"]) {
      fs.writeFileSync(script, `import runpy, subprocess, sys\n` +
        `def fail(*args, **kwargs):\n raise OSError('synthetic process limit')\nsubprocess.Popen = fail\n` +
        `sys.argv = [${JSON.stringify(SCRIPT)}, ${JSON.stringify(flag)}]\nrunpy.run_path(${JSON.stringify(SCRIPT)}, run_name='__main__')\n`);
      const result = await run(env, [], "{}", null, script);
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.out), flag === "--hook" ? { decision: "stop" } : {});
      assert.match(result.err, /worker launch failed/);
    }
  });
});

// Exercise real scan/upload/checkpoint logic with smaller resource budgets.
describe("Antigravity quota reports", () => {
  let srv, home, env, key;
  const calls = () => JSON.parse(fs.readFileSync(path.join(home, "calls.json"), "utf8"));
  const statePath = () => path.join(home, ".cache", "ai-activity", "antigravity.json");
  const clearThrottle = () => {
    if (!fs.existsSync(statePath())) return;
    const state = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    delete state.quota_tried_at; delete state.quota_failed;
    fs.writeFileSync(statePath(), JSON.stringify(state));
  };
  const sample = () => {
    const now = Math.floor(Date.now() / 1000);
    return { status: "SUCCESS", command: { name: "usage", data: { email: "PRIVATE_EMAIL", groups: [
      { display_name: "Gemini Models", buckets: [
        { bucket_id: "gemini-5h", remaining: { remaining_fraction: 0.75 }, reset_time: new Date((now + 3600) * 1000).toISOString() },
        { bucket_id: "gemini-weekly", remaining: { case: "remainingFraction", value: 0.5 }, reset_time: new Date((now + 86400) * 1000).toISOString() },
      ] },
      { displayName: "Claude and GPT models", buckets: [
        { bucketId: "3p-5h", remainingFraction: 1, resetTime: new Date((now + 7200) * 1000).toISOString() },
        { bucketId: "3p-weekly", remaining: { remainingFraction: 0.3 }, resetTime: new Date((now + 172800) * 1000).toISOString() },
      ] },
    ] } }, credential: "PRIVATE_CREDENTIAL" };
  };
  const collect = (report, { version = "1.1.11", timeout = false, checkUsage = false, key: uploadKey = key } = {}) => {
    const script = path.join(home, "quota-test.py");
    fs.writeFileSync(script, `import importlib.util, json, os, pathlib, subprocess, types\n` +
      `spec = importlib.util.spec_from_file_location('collector', ${JSON.stringify(SCRIPT)})\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\n` +
      `calls = []\nreport = json.loads(${JSON.stringify(JSON.stringify(report))})\nm.shutil.which = lambda name: '/fake/agy'\n` +
      `def command(args, **options):\n` +
      ` assert options['env']['AI_ACTIVITY_ANTIGRAVITY_QUOTA_PROBE'] == '1'\n` +
      ` assert 'AI_ACTIVITY_KEY' not in options['env'] and 'AI_ACTIVITY_URL' not in options['env']\n` +
      ` assert list(pathlib.Path(options['cwd']).iterdir()) == []\n` +
      ` assert options['stdin'] == subprocess.DEVNULL and options['stderr'] == subprocess.DEVNULL\n` +
      ` calls.append(args[1:])\n pathlib.Path(${JSON.stringify(path.join(home, "calls.json"))}).write_text(json.dumps(calls))\n` +
      (checkUsage ? ` import urllib.request\n assert json.load(urllib.request.urlopen(m.SERVER + '/api/u/admin/summary?tool=antigravity'))['total']['events'] == 1\n` : "") +
      ` if args[1:] == ['--version']:\n  options['stdout'].write(${JSON.stringify(version)}.encode())\n` +
      ` else:\n  assert args[1:] == ['-p', '/usage', '--output-format', 'json', '--print-timeout', '90s']\n` +
      (timeout ? `  raise subprocess.TimeoutExpired(args, options['timeout'])\n` : `  options['stdout'].write(json.dumps(report).encode())\n`) +
      ` return types.SimpleNamespace(returncode=0)\nm.subprocess.run = command\ntry:\n m.collect()\nexcept Exception:\n import traceback\n traceback.print_exc()\n raise SystemExit(1)\n`);
    return run({ ...env, AI_ACTIVITY_KEY: uploadKey, AI_ACTIVITY_ANTIGRAVITY_QUOTAS: "1" }, [], "", null, script);
  };
  const quotas = async () => (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas;
  before(async () => {
    srv = await startServer(); key = (await newDevice(srv.base)).key;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-activity-antigravity-quotas-"));
    env = { HOME: home, USERPROFILE: home, GEMINI_CLI_HOME: path.join(home, ".gemini"), AI_ACTIVITY_URL: srv.base };
  });
  after(() => { srv.stop(); fs.rmSync(home, { recursive: true, force: true }); });

  test("CLI report uploads both pools without usage or private fields, then throttles successful probes", async () => {
    assert.equal((await collect(sample())).code, 0);
    assert.deepEqual(calls(), [["--version"], ["-p", "/usage", "--output-format", "json", "--print-timeout", "90s"]]);
    const rows = await quotas();
    assert.deepEqual(rows.map(q => [q.account_ref, q.limit_type, q.used_pct]),
      [["claude-gpt", "five_hour", 0], ["claude-gpt", "seven_day", 70], ["gemini", "five_hour", 25], ["gemini", "seven_day", 50]]);
    assert.equal((await req(srv.base, "GET", "/api/u/admin/summary?tool=antigravity")).json.total.events, 0);
    assert.ok(rows.every(q => q.resets_at > q.measured_at));
    const saved = fs.readFileSync(statePath(), "utf8");
    for (const secret of [key, "PRIVATE_EMAIL", "PRIVATE_CREDENTIAL"]) {
      assert.ok(!saved.includes(secret)); assert.ok(!JSON.stringify(rows).includes(secret));
    }
    fs.unlinkSync(path.join(home, "calls.json"));
    assert.equal((await collect(sample())).code, 0);
    assert.ok(!fs.existsSync(path.join(home, "calls.json")), "no probe within the successful one-minute interval");
  });

  test("old/unknown versions cannot invoke /usage; failed probes and uploads remain retryable", async () => {
    clearThrottle();
    for (const version of ["1.1.10", "unknown", "1.2.0-beta"]) {
      clearThrottle();
      const r = await collect(sample(), { version }); assert.equal(r.code, 0); assert.match(r.err, /quota report unavailable/);
      assert.deepEqual(calls(), [["--version"]]);
    }
    clearThrottle();
    const timed = await collect(sample(), { timeout: true }); assert.equal(timed.code, 0, timed.err);
    fs.unlinkSync(path.join(home, "calls.json"));
    assert.equal((await collect(sample(), { timeout: true })).code, 0);
    assert.ok(!fs.existsSync(path.join(home, "calls.json")), "failed probes back off across processes");
    const saved = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    assert.equal(saved.quota_failed, true);
    saved.quota_tried_at -= 301; fs.writeFileSync(statePath(), JSON.stringify(saved));
    assert.equal((await collect(sample())).code, 0, "retry succeeds after five-minute backoff");
    assert.equal((await collect(sample(), { key: "invalid-device-key" })).code, 1);
    assert.equal(JSON.parse(fs.readFileSync(statePath(), "utf8")).quota_failed, true);
    assert.equal((await collect(sample())).code, 0);
    assert.equal(JSON.parse(fs.readFileSync(statePath(), "utf8")).quota_failed, false);
  });

  test("unknown, disabled, duplicate, invalid and expired buckets cannot produce quota measurements", async () => {
    clearThrottle();
    const invalid = sample();
    invalid.command.data.groups = [{ buckets: [
      { bucketId: "unknown-weekly", remainingFraction: 0.1 },
      { bucketId: "gemini-5h", remainingFraction: 0.5, disabled: true },
      { bucketId: "gemini-weekly", remainingFraction: 0.9 },
      { bucketId: "gemini-weekly", remainingFraction: 0.1 },
      { bucketId: "3p-5h", remainingFraction: 0.5, resetTime: "2020-01-01T00:00:00Z" },
      { bucketId: "3p-weekly", remainingFraction: 1.1 },
    ] }];
    const before = await quotas();
    assert.match((await collect(invalid)).err, /quota report unavailable/);
    assert.deepEqual(await quotas(), before);
    invalid.status = "FAILED";
    clearThrottle();
    assert.match((await collect(invalid)).err, /quota report unavailable/);
    assert.deepEqual(await quotas(), before);
    // The real API also rejects percentages outside the measured range and
    // implausible resets even if a client bypasses the Python parser.
    await req(srv.base, "POST", "/api/ingest/antigravity", { key, body: { messages: [], account_ref: "invalid", rate_limits: {
      five_hour: { used_percentage: 101 }, seven_day: { used_percentage: -1 }, custom: { used_percentage: 10 },
    } } });
    assert.deepEqual(await quotas(), before);
    for (const ref of [undefined, "default", "unknown", "Gemini", "gemini "]) {
      await req(srv.base, "POST", "/api/ingest/antigravity", { key, body: {
        messages: [], account_ref: ref, rate_limits: { five_hour: { used_percentage: 25 } },
      } });
      assert.deepEqual(await quotas(), before, "unknown pools must not store invisible quota rows");
    }
  });

  test("quota subprocess hooks return normally without spawning recursive collectors", async () => {
    const prior = fs.readFileSync(statePath(), "utf8");
    for (const arg of ["--hook", "--post-invocation"]) {
      const r = await run({ ...env, AI_ACTIVITY_KEY: key, AI_ACTIVITY_ANTIGRAVITY_QUOTA_PROBE: "1" }, [arg], "{}");
      assert.equal(r.code, 0); assert.deepEqual(JSON.parse(r.out), arg === "--hook" ? { decision: "stop" } : {});
    }
    await new Promise(resolve => setTimeout(resolve, 2300));
    assert.equal(fs.readFileSync(statePath(), "utf8"), prior);
  });

  test("token uploads finish before a failing quota probe starts", async () => {
    const dir = path.join(home, ".gemini", "antigravity-cli", "conversations");
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, "quota-timeout.db"));
    db.exec("CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB)");
    db.prepare("INSERT INTO gen_metadata VALUES (1, ?)").run(generation("before-probe")); db.close();
    clearThrottle();
    assert.equal((await collect(sample(), { timeout: true, checkUsage: true })).code, 0);
    assert.equal((await req(srv.base, "GET", "/api/u/admin/summary?tool=antigravity")).json.total.events, 1);
    fs.unlinkSync(path.join(home, "calls.json"));
    assert.equal((await collect(sample(), { checkUsage: true })).code, 0);
    assert.ok(!fs.existsSync(path.join(home, "calls.json")));
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
    if (refuse) { response.statusCode = 400; response.end("{}"); return; }
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
  const collect = async (limits, slow = false, setup = "") => {
    const script = path.join(home, "bounded-test.py");
    fs.writeFileSync(script, `import importlib.util, time\nspec = importlib.util.spec_from_file_location('collector', ${JSON.stringify(SCRIPT)})\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\n` +
      Object.entries(limits).map(([key, value]) => `m.${key} = ${value}\n`).join("") +
      (slow ? "original = m.read_database\ndef slow(*args):\n time.sleep(0.03)\n return original(*args)\nm.read_database = slow\n" : "") +
      setup + "try:\n m.collect()\nexcept Exception:\n import traceback\n traceback.print_exc()\n raise SystemExit(1)\n");
    return run(env, [], "", null, script);
  };
  return { add, state, collect, accepted, batches, dir, refuse: value => refuse = value,
    close: async () => { await new Promise(resolve => proxy.close(resolve)); fs.rmSync(home, { recursive: true, force: true }); } };
}

test("source-count budgets resume past the previous cursor instead of starving later databases", async () => {
  const f = await scanFixture();
  try {
    for (let i = 0; i < 7; i++) f.add(`conversation${i}`, [generation(`response${i}`)]);
    for (let i = 0; i < 3; i++) {
      const result = await f.collect({ MAX_DATABASES: 3 }); assert.equal(result.code, 0, result.err);
    }
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

test("timestamp matching gets its own deadline after generation page reading exhausts its budget", async () => {
  const f = await scanFixture();
  try {
    f.add("deadline", [generation("matched", { when: null, step: "unique", bot: "unique" }), generation("native")],
      [Buffer.concat([bytes(1, stamp(WHEN + 60)), bytes(12, "unique"), bytes(9, bytes(7, "unique"))])]);
    const setup = "original_parse = m.parse\ndef delayed(blob):\n time.sleep(0.06)\n return original_parse(blob)\nm.parse = delayed\n";
    assert.equal((await f.collect({ MAX_SCAN_SECONDS: 0.03 }, false, setup)).code, 0);
    assert.equal(f.accepted.get("deadline:matched").occurred_at, WHEN + 60);
    assert.equal(Object.values(f.state().positions)[0], 1);
    assert.equal((await f.collect({})).code, 0); assert.equal(f.accepted.size, 2);
  } finally { await f.close(); }
});

test("an interrupted match on a middle page cannot advance past unresolved generations", async () => {
  const f = await scanFixture();
  try {
    f.add("retry", [generation("first"), generation("matched", { when: null, step: "unique", bot: "unique" }), generation("last")],
      [Buffer.concat([bytes(1, stamp(WHEN + 60)), bytes(12, "unique"), bytes(9, bytes(7, "unique"))])]);
    assert.equal((await f.collect({ MAX_ROWS: 1 })).code, 0);
    const originalPosition = f.state().positions;
    const setup = "m.matched_times = lambda *args: None\n";
    for (let i = 0; i < 2; i++) assert.equal((await f.collect({ MAX_ROWS: 1 }, false, setup)).code, 0);
    assert.deepEqual(f.state().positions, originalPosition);
    assert.equal(f.accepted.size, 1);
    for (let i = 0; i < 2; i++) assert.equal((await f.collect({ MAX_ROWS: 1 })).code, 0);
    assert.equal(f.accepted.size, 3);
  } finally { await f.close(); }
});


test("unchanged completed sources skip SQLite scans; old-row WAL edits invalidate stamps and completed ranks are discarded", async () => {
  const f = await scanFixture();
  let db;
  try {
    f.add("wal", [generation("old")]);
    db = new Database(path.join(f.dir, "wal.db")); db.pragma("journal_mode = WAL");
    db.prepare("UPDATE gen_metadata SET data=? WHERE idx=1").run(generation("old"));
    assert.equal((await f.collect({})).code, 0);
    assert.deepEqual(f.state().sent, {});
    assert.ok(Object.values(f.state().files).every(x => x.complete));
    const noScan = "m.read_database = lambda *args: (_ for _ in ()).throw(AssertionError('unchanged source scanned'))\n";
    assert.equal((await f.collect({}, false, noScan)).code, 0);
    const before = fs.statSync(path.join(f.dir, "wal.db")).mtimeMs;
    db.prepare("UPDATE gen_metadata SET data=? WHERE idx=1").run(generation("old", { output: 80 }));
    assert.equal(fs.statSync(path.join(f.dir, "wal.db")).mtimeMs, before, "change is in WAL only");
    assert.equal((await f.collect({})).code, 0);
    assert.equal(f.accepted.get("wal:old").usage.output_tokens, 110);
    assert.deepEqual(f.state().sent, {});
    db.close(); db = null;
    assert.equal((await f.collect({})).code, 0, "WAL disappearance also invalidates stamp");
  } finally { db?.close(); await f.close(); }
});

test("writes during a read cannot certify an unchanged snapshot or retain a stale page cursor", async () => {
  const f = await scanFixture();
  try {
    f.add("racing", [generation("first")]);
    const setup = `original = m.read_database\ndef racing(path, after=None):\n result = original(path, after)\n import sqlite3\n with sqlite3.connect(path) as db:\n  db.execute('INSERT INTO gen_metadata VALUES (2, ?)', (bytes.fromhex('${generation("second").toString("hex")}'),))\n return result\nm.read_database = racing\n`;
    assert.equal((await f.collect({}, false, setup)).code, 0);
    assert.ok(Object.values(f.state().files).every(x => !x.complete));
    assert.deepEqual(f.state().positions, {});
    assert.equal((await f.collect({})).code, 0);
    assert.equal(f.accepted.size, 2);
  } finally { await f.close(); }
});

test("discovery excludes app-root databases and prunes checkpoints for deleted conversations", async () => {
  const f = await scanFixture();
  try {
    f.add("valid", [generation("valid")]);
    fs.copyFileSync(path.join(f.dir, "valid.db"), path.join(f.dir, "..", "decoy.db"));
    assert.equal((await f.collect({})).code, 0);
    assert.equal(f.accepted.size, 1);
    fs.unlinkSync(path.join(f.dir, "valid.db"));
    assert.equal((await f.collect({})).code, 0);
    assert.deepEqual(f.state().files, {});
    assert.deepEqual(f.state().sent, {});
  } finally { await f.close(); }
});

test("unconfigured placeholders fail before database discovery or cache creation", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-activity-unconfigured-"));
  try {
    for (const config of [{ AI_ACTIVITY_URL: "<server>", AI_ACTIVITY_KEY: "test" },
      { AI_ACTIVITY_URL: "http://localhost", AI_ACTIVITY_KEY: "<device key>" }]) {
      assert.equal((await run({ HOME: home, USERPROFILE: home, ...config })).code, 1);
      assert.ok(!fs.existsSync(path.join(home, ".cache")));
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("first HTTP failure stops sources and quota probing; Retry-After delays retries without losing accepted batches", async () => {
  const f = await scanFixture();
  try {
    f.add("first", Array.from({ length: 250 }, (_, i) => generation(`response${i}`)));
    f.add("second", [generation("other")]);
    const setup = `import urllib.error\nimport urllib.request\nopen_original = urllib.request.OpenerDirector.open\ncalls = 0\ndef fail_second(self, *args, **kwargs):\n global calls\n calls += 1\n if calls == 2:\n  raise urllib.error.HTTPError('redacted', 429, 'limited', {'Retry-After': '120'}, None)\n return open_original(self, *args, **kwargs)\nurllib.request.OpenerDirector.open = fail_second\nm.os.environ['AI_ACTIVITY_ANTIGRAVITY_QUOTAS'] = '1'\nm.read_quotas = lambda: (_ for _ in ()).throw(AssertionError('quota probe after upload failure'))\n`;
    assert.equal((await f.collect({}, false, setup)).code, 1);
    assert.equal(f.accepted.size, 200);
    assert.equal(f.batches.length, 1);
    assert.ok(Object.values(f.state().files).every(x => !x.complete));
    assert.equal((await f.collect({})).code, 1);
    assert.equal(f.batches.length, 1, "Retry-After suppresses every upload");
    const noWait = "import time\noriginal_time = time.time\ntime.time = lambda: original_time() + 121\n";
    assert.equal((await f.collect({}, false, noWait)).code, 0);
    assert.equal(f.accepted.size, 251);
    assert.equal(f.batches.flat().filter(e => e.session_id === 'first').length, 250);
    assert.deepEqual(f.state().sent, {});
  } finally { await f.close(); }
});

test("Windows detach requests console/group/job independence and falls back only for denied breakaway", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-activity-detach-"));
  try {
    const script = path.join(home, "detach.py");
    fs.writeFileSync(script, `import importlib.util, types\nspec = importlib.util.spec_from_file_location('collector', ${JSON.stringify(SCRIPT)})\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nm.os = types.SimpleNamespace(name='nt')\nm.subprocess.DETACHED_PROCESS = 8\nm.subprocess.CREATE_NEW_PROCESS_GROUP = 512\nm.subprocess.CREATE_BREAKAWAY_FROM_JOB = 16777216\ncalls = []\ndef popen(*args, **kwargs):\n calls.append(kwargs['creationflags'])\n if len(calls) == 1:\n  e = OSError('denied'); e.winerror = 5; raise e\nm.subprocess.Popen = popen\nm.launch_worker()\nassert calls == [8 | 512 | 16777216, 8 | 512]\n`);
    const result = await run({}, [], "", null, script);
    assert.equal(result.code, 0, result.err);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});


test("HTTP-date retry delays and malformed Retry-After use bounded persistent backoff", async () => {
  const f = await scanFixture();
  try {
    f.add("retrydate", [generation("one")]);
    for (const [header, seconds] of [[new Date(Date.now() + 120000).toUTCString(), 120], ["nonsense", 60], ["999999999", 86400]]) {
      const setup = `import urllib.request, urllib.error\ndef fail(*args, **kwargs):\n raise urllib.error.HTTPError('redacted', 503, 'unavailable', {'Retry-After': ${JSON.stringify(header)}}, None)\nurllib.request.OpenerDirector.open = fail\n`;
      // Expire the previous delay while retaining the source's incomplete checkpoint.
      const stateFile = path.join(f.dir, "..", "..", "..", ".cache", "ai-activity", "antigravity.json");
      if (fs.existsSync(stateFile)) { const v = JSON.parse(fs.readFileSync(stateFile)); delete v.upload_retry_at; fs.writeFileSync(stateFile, JSON.stringify(v)); }
      const before = Date.now() / 1000;
      assert.equal((await f.collect({}, false, setup)).code, 1);
      const delay = f.state().upload_retry_at - before;
      assert.ok(delay > seconds - 3 && delay <= seconds + 3, `${header}: ${delay}`);
    }
    assert.equal(f.batches.length, 0);
  } finally { await f.close(); }
});

test("network failures and rejected redirects stop the pass without sending a second source", async () => {
  const f = await scanFixture();
  try {
    f.add("first", [generation("one")]); f.add("second", [generation("two")]);
    for (const failure of ["urllib.error.URLError('offline')", "urllib.error.HTTPError('redacted', 302, 'redirect', {}, None)"]) {
      const setup = `import urllib.request, urllib.error\ndef fail(*args, **kwargs):\n raise ${failure}\nurllib.request.OpenerDirector.open = fail\n`;
      const result = await f.collect({}, false, setup);
      assert.equal(result.code, 1);
      assert.equal(f.batches.length, 0);
    }
  } finally { await f.close(); }
});


test("an actual HTTP redirect cannot forward the device bearer key", async () => {
  const f = await scanFixture();
  let received = 0;
  const destination = http.createServer((request, response) => { received++; response.end('{}'); });
  await new Promise(resolve => destination.listen(0, "127.0.0.1", resolve));
  const source = http.createServer((request, response) => {
    response.writeHead(307, { Location: `http://127.0.0.1:${destination.address().port}/ingest` }); response.end();
  });
  await new Promise(resolve => source.listen(0, "127.0.0.1", resolve));
  try {
    f.add("redirect", [generation("one")]);
    const setup = `m.SERVER = 'http://127.0.0.1:${source.address().port}'\n`;
    assert.equal((await f.collect({}, false, setup)).code, 1);
    assert.equal(received, 0);
  } finally {
    await new Promise(resolve => source.close(resolve));
    await new Promise(resolve => destination.close(resolve));
    await f.close();
  }
});
