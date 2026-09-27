// Synthetic wire fixtures for the independently observed Antigravity SQLite
// layout; runs the actual Python collector against the actual ingestion API.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import http from "node:http";
import { createHash } from "node:crypto";
import { startServer, req, newDevice, isLocked, collectorTarget, targetOffsets } from "./helpers.js";

const SCRIPT = fileURLToPath(new URL("../collectors/antigravity.py", import.meta.url));
// Absolute interpreter, so tests can run the collector with a PATH of their own.
const PYTHON = spawnSync(process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"),
  ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
const PATH_KEY = Object.keys(process.env).find(k => k.toUpperCase() === "PATH") || "PATH";
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
// Quota probing is opt-in; the developer's own environment never enables it here.
const withoutQuotaOptIn = ({ AI_ACTIVITY_ANTIGRAVITY_QUOTAS, ...rest }) => rest;
const run = (env, args = [], input = "", command = null, script = SCRIPT) => new Promise((resolve, reject) => {
  const p = spawn(command || PYTHON, command ? [] : [script, ...args],
    { env: { ...withoutQuotaOptIn(process.env), ...env }, shell: !!command, stdio: ["pipe", "pipe", "pipe"] });
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

  test("unsupported databases are skipped until they change instead of failing every run", async () => {
    const dir = path.join(home, ".gemini", "antigravity-cli", "conversations");
    const broken = path.join(dir, "broken.db"), layout = path.join(dir, "layout.db");
    fs.writeFileSync(broken, "not a SQLite database");
    const other = new Database(layout); other.exec("CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, other BLOB)"); other.close();
    try {
      const first = await run(env); assert.equal(first.code, 0, first.err);
      assert.equal(first.err.match(/conversation database skipped/g).length, 2);
      const again = await run(env); assert.equal(again.code, 0); assert.doesNotMatch(again.err, /unsupported/);
      fs.appendFileSync(broken, "changed");
      assert.match((await run(env)).err, /conversation database skipped/);
      assert.equal((await summary()).events, 4);
    } finally { fs.unlinkSync(broken); fs.unlinkSync(layout); }
    assert.equal((await run(env)).code, 0);
    assert.equal(Object.keys(targetOffsets(statePath(), srv.base, key).files).length, 1);
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
      // The detached worker starts after a delay: poll the stored tokens,
      // then wait until it released the collection lock (state saved), so
      // the next iteration starts clean.
      let tokens = 0;
      for (let i = 0; i < 60; i++) {
        tokens = (await summary()).tokens;
        if (tokens === 2620 + output) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.equal(tokens, 2620 + output); assert.equal((await summary()).events, 4);
      const collection = path.join(home, ".cache", "ai-activity", "antigravity.lock");
      for (let i = 0; i < 150 && isLocked(collection); i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(!isLocked(collection), "the detached worker released the collection lock");
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
      // The detached Stop worker queues behind the in-flight upload: wait
      // until it holds the waiter lock, so the next assert means something.
      const waiter = path.join(home, ".cache", "ai-activity", "antigravity-waiter.lock");
      for (let i = 0; i < 150 && !isLocked(waiter); i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(isLocked(waiter), "the detached Stop worker queued behind the upload");
      assert.equal(batches.length, 1);
      release(); assert.equal((await first).code, 0);
      for (let i = 0; i < 150 && batches.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 100));
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
      // Twelve concurrent python3 startups: allow a loaded runner the same
      // budget as a detached collector drain.
      for (let i = 0; i < 300 && results.length < 11; i++) await new Promise(resolve => setTimeout(resolve, 100));
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

// A fake `agy` first on PATH: answers from bin/agy.json, logs every call
// (argv, working directory, environment) to bin/calls.json, and holds the
// /usage probe while bin/hold exists.
const FAKE_AGY = `import json, os, pathlib, sys, time, urllib.request
here = pathlib.Path(__file__).resolve().parent
control = json.loads((here / "agy.json").read_text())
args = sys.argv[1:]
call = {"argv": args, "cwd_empty": not any(pathlib.Path.cwd().iterdir()), "stdin": sys.stdin.read(),
        "probe": os.environ.get("AI_ACTIVITY_ANTIGRAVITY_QUOTA_PROBE"),
        "leaked": [k for k in ("AI_ACTIVITY_KEY", "AI_ACTIVITY_URL") if k in os.environ]}
if control.get("check_url"):
    call["events"] = json.load(urllib.request.urlopen(control["check_url"]))["total"]["events"]
log = here / "calls.json"
log.write_text(json.dumps((json.loads(log.read_text()) if log.exists() else []) + [call]))
print("AGY STDERR MUST STAY LOCAL", file=sys.stderr)
if args == ["--version"]:
    print(control["version"])
    sys.exit(0)
(here / "probing").touch()
while (here / "hold").exists():
    time.sleep(0.05)
if control.get("fail"):
    sys.exit(1)
print(json.dumps(control["report"]))
`;

function fakeAgy(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(dir, "fake-agy.py"), FAKE_AGY);
    fs.writeFileSync(path.join(dir, "agy.cmd"), `@"${PYTHON}" "%~dp0fake-agy.py" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(dir, "agy"), `#!${PYTHON}\n` + FAKE_AGY, { mode: 0o755 });
  }
}

describe("Antigravity quota reports", () => {
  let srv, home, env, key, bin;
  const callsPath = () => path.join(bin, "calls.json");
  const calls = () => fs.existsSync(callsPath()) ? JSON.parse(fs.readFileSync(callsPath(), "utf8")) : [];
  const argv = () => calls().map(c => c.argv);
  const resetCalls = () => fs.rmSync(callsPath(), { force: true });
  const USAGE = ["-p", "/usage", "--output-format", "json", "--print-timeout", "90s"];
  const statePath = () => path.join(home, ".cache", "ai-activity", "antigravity.json");
  const quotaPath = () => path.join(home, ".cache", "ai-activity", "antigravity-quota.json");
  const quotaState = () => JSON.parse(fs.readFileSync(quotaPath(), "utf8"));
  const clearThrottle = () => fs.rmSync(quotaPath(), { force: true });
  const sample = () => {
    const now = Math.floor(Date.now() / 1000);
    return { status: "SUCCESS", command: { name: "usage", data: { email: "PRIVATE_EMAIL", groups: [
      { display_name: "Gemini Models", buckets: [
        // The shape agy 1.2.11 prints.
        { id: "gemini-5h", name: "Five Hour Limit", window: "5h", remaining_fraction: 0.75, reset_time: new Date((now + 3600) * 1000).toISOString() },
        { bucket_id: "gemini-weekly", remaining: { case: "remainingFraction", value: 0.5 }, reset_time: new Date((now + 86400) * 1000).toISOString() },
      ] },
      { displayName: "Claude and GPT models", buckets: [
        { bucketId: "3p-5h", remainingFraction: 1, resetTime: new Date((now + 7200) * 1000).toISOString() },
        { bucketId: "3p-weekly", remaining: { remainingFraction: 0.3 }, resetTime: new Date((now + 172800) * 1000).toISOString() },
      ] },
    ] } }, credential: "PRIVATE_CREDENTIAL" };
  };
  const collect = (report = sample(), { version = "1.1.11", fail = false, checkUsage = false, key: uploadKey = key, extra = {} } = {}) => {
    fs.writeFileSync(path.join(bin, "agy.json"), JSON.stringify({ version, fail, report,
      check_url: checkUsage ? `${srv.base}/api/u/admin/summary?tool=antigravity` : null }));
    return run({ ...env, AI_ACTIVITY_KEY: uploadKey, AI_ACTIVITY_ANTIGRAVITY_QUOTAS: "1", ...extra });
  };
  const quotas = async () => (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas;
  const waitFor = async (file) => {
    for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(fs.existsSync(file), `${file} never appeared`);
  };
  before(async () => {
    srv = await startServer(); key = (await newDevice(srv.base)).key;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-activity-antigravity-quotas-"));
    bin = path.join(home, "bin"); fakeAgy(bin);
    env = { HOME: home, USERPROFILE: home, GEMINI_CLI_HOME: path.join(home, ".gemini"), AI_ACTIVITY_URL: srv.base,
      [PATH_KEY]: bin + path.delimiter + process.env[PATH_KEY] };
  });
  after(() => { srv.stop(); fs.rmSync(home, { recursive: true, force: true }); });

  test("quota probing is off unless AI_ACTIVITY_ANTIGRAVITY_QUOTAS=1", async () => {
    for (const value of [undefined, "0", "true", ""]) {
      clearThrottle(); fs.rmSync(callsPath(), { force: true });
      const extra = { AI_ACTIVITY_ANTIGRAVITY_QUOTAS: value };
      if (value === undefined) delete extra.AI_ACTIVITY_ANTIGRAVITY_QUOTAS;
      const r = await run({ ...env, AI_ACTIVITY_KEY: key, ...extra }); assert.equal(r.code, 0, r.err);
      assert.deepEqual(calls(), [], `${value}: agy must not run`);
    }
    assert.deepEqual((await quotas()).filter(q => q.tool === "antigravity"), []);
  });

  test("CLI report uploads both pools without usage or private fields, then throttles successful probes", async () => {
    const r = await collect(); assert.equal(r.code, 0, r.err);
    assert.deepEqual(argv(), [["--version"], USAGE]);
    for (const call of calls()) {
      assert.equal(call.cwd_empty, true); assert.equal(call.probe, "1");
      assert.deepEqual(call.leaked, []); assert.equal(call.stdin, "");
    }
    assert.ok(!r.err.includes("AGY STDERR") && !r.err.includes("PRIVATE") && !r.out.includes("PRIVATE"));
    const rows = await quotas();
    assert.deepEqual(rows.map(q => [q.account_ref, q.limit_type, q.used_pct]),
      [["claude-gpt", "five_hour", 0], ["claude-gpt", "seven_day", 70], ["gemini", "five_hour", 25], ["gemini", "seven_day", 50]]);
    assert.equal((await req(srv.base, "GET", "/api/u/admin/summary?tool=antigravity")).json.total.events, 0);
    assert.ok(rows.every(q => q.resets_at > q.measured_at));
    const saved = fs.readFileSync(quotaPath(), "utf8");
    for (const secret of [key, "PRIVATE_EMAIL", "PRIVATE_CREDENTIAL"]) {
      assert.ok(!saved.includes(secret)); assert.ok(!JSON.stringify(rows).includes(secret));
    }
    resetCalls();
    assert.equal((await collect()).code, 0);
    assert.deepEqual(calls(), [], "no probe within the successful one-minute interval");
  });

  test("diagnostics tell a missing CLI, an unsupported version and a failed probe apart; failures back off", async () => {
    clearThrottle();
    const missing = await collect(sample(), { extra: { [PATH_KEY]: path.join(home, ".gemini") } });
    assert.equal(missing.code, 0); assert.match(missing.err, /quota report unavailable \(agy CLI not found on PATH\)/);
    for (const version of ["1.1.10", "unknown", "agy 1.0.9 (build 1.2.3)"]) {
      clearThrottle(); resetCalls();
      const r = await collect(sample(), { version }); assert.equal(r.code, 0);
      assert.match(r.err, /quota report unavailable \(agy version [^;]+; 1\.1\.11 or later required\)/);
      assert.deepEqual(argv(), [["--version"]], `${version} must never receive /usage`);
    }
    clearThrottle(); resetCalls();
    assert.equal((await collect(sample(), { version: "Antigravity CLI 1.2.0 (abc123)" })).code, 0);
    assert.deepEqual(argv(), [["--version"], USAGE], "a version inside other text is found");
    clearThrottle();
    const failed = await collect(sample(), { fail: true }); assert.equal(failed.code, 0, failed.err);
    assert.match(failed.err, /quota report unavailable \(agy -p \/usage failed\)/);
    resetCalls();
    assert.equal((await collect()).code, 0);
    assert.deepEqual(calls(), [], "failed probes back off across processes");
    const saved = quotaState(); assert.equal(saved.failed, true);
    saved.tried_at -= 301; fs.writeFileSync(quotaPath(), JSON.stringify(saved));
    assert.equal((await collect()).code, 0, "retry succeeds after five-minute backoff");
    assert.equal(quotaState().failed, false);
    clearThrottle();
    assert.equal((await collect(sample(), { key: "invalid-device-key" })).code, 1);
    assert.equal(quotaState().failed, true);
    clearThrottle();
    assert.equal((await collect()).code, 0);
    assert.equal(quotaState().failed, false);
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
    // Untouched windows (full, resetting a whole window from now, or never)
    // were not started: they stay unavailable rather than showing 0%.
    const unused = sample(), now = Math.floor(Date.now() / 1000);
    unused.command.data.groups = [{ buckets: [
      { id: "gemini-5h", window: "5h", remaining_fraction: 1, reset_time: new Date((now + 18000) * 1000).toISOString() },
      { id: "gemini-weekly", window: "weekly", remaining_fraction: 1, reset_time: new Date((now + 604800 - 60) * 1000).toISOString() },
      { id: "3p-5h", window: "5h", remaining_fraction: 1 },
    ] }];
    clearThrottle();
    assert.match((await collect(unused)).err, /quota report unavailable/);
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
    const snapshot = () => [statePath(), quotaPath()].map(p => fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
    const prior = snapshot();
    for (const arg of ["--hook", "--post-invocation"]) {
      const r = await run({ ...env, AI_ACTIVITY_KEY: key, AI_ACTIVITY_ANTIGRAVITY_QUOTA_PROBE: "1" }, [arg], "{}");
      assert.equal(r.code, 0); assert.deepEqual(JSON.parse(r.out), arg === "--hook" ? { decision: "stop" } : {});
    }
    await new Promise(resolve => setTimeout(resolve, 2300));
    assert.deepEqual(snapshot(), prior);
  });

  test("token uploads finish before a failing quota probe starts", async () => {
    const dir = path.join(home, ".gemini", "antigravity-cli", "conversations");
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, "quota-timeout.db"));
    db.exec("CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB)");
    db.prepare("INSERT INTO gen_metadata VALUES (1, ?)").run(generation("before-probe")); db.close();
    clearThrottle(); resetCalls();
    assert.equal((await collect(sample(), { fail: true, checkUsage: true })).code, 0);
    assert.deepEqual(calls().map(c => c.events), [1, 1]);
    resetCalls();
    assert.equal((await collect(sample(), { checkUsage: true })).code, 0);
    assert.deepEqual(calls(), []);
  });

  test("a slow probe runs outside the collection lock; a concurrent run collects tokens and skips probing", async () => {
    clearThrottle(); resetCalls();
    fs.rmSync(path.join(bin, "probing"), { force: true });
    fs.writeFileSync(path.join(bin, "hold"), "");
    const slow = collect();
    try {
      await waitFor(path.join(bin, "probing"));
      const db = new Database(path.join(home, ".gemini", "antigravity-cli", "conversations", "quota-timeout.db"));
      db.prepare("INSERT INTO gen_metadata VALUES (2, ?)").run(generation("during-probe")); db.close();
      clearThrottle();
      const quick = await collect(); assert.equal(quick.code, 0, quick.err);
      assert.equal((await req(srv.base, "GET", "/api/u/admin/summary?tool=antigravity")).json.total.events, 2);
      assert.deepEqual(argv(), [["--version"], USAGE], "the concurrent run never probes");
    } finally { fs.rmSync(path.join(bin, "hold"), { force: true }); }
    assert.equal((await slow).code, 0);
  });

  test("a refused quota upload backs off quotas only, never token uploads", async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "ai-activity-antigravity-quota429-"));
    const dir = path.join(other, ".gemini", "antigravity-cli", "conversations");
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, "limited.db"));
    db.exec("CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB)");
    db.prepare("INSERT INTO gen_metadata VALUES (1, ?)").run(generation("t1"));
    const bodies = [];
    const proxy = http.createServer(async (request, response) => {
      let body = ""; for await (const b of request) body += b;
      const payload = JSON.parse(body); bodies.push(payload);
      response.setHeader("content-type", "application/json");
      if (!payload.messages.length) { response.writeHead(429, { "Retry-After": "3600" }); response.end("{}"); return; }
      response.end(JSON.stringify({ ok: true, messages: payload.messages.length }));
    });
    await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const local = { ...env, HOME: other, USERPROFILE: other, GEMINI_CLI_HOME: path.join(other, ".gemini"),
      AI_ACTIVITY_URL: `http://127.0.0.1:${proxy.address().port}`, AI_ACTIVITY_KEY: "test-key", AI_ACTIVITY_ANTIGRAVITY_QUOTAS: "1" };
    const cache = path.join(other, ".cache", "ai-activity");
    try {
      fs.writeFileSync(path.join(bin, "agy.json"), JSON.stringify({ version: "1.1.11", report: sample() }));
      const before = Date.now() / 1000;
      assert.equal((await run(local)).code, 1, "a refused quota upload is reported");
      assert.deepEqual(bodies.map(b => b.messages.length), [1, 0]);
      assert.equal(targetOffsets(path.join(cache, "antigravity.json"), local.AI_ACTIVITY_URL, "test-key").upload_retry_at, undefined);
      const retry = JSON.parse(fs.readFileSync(path.join(cache, "antigravity-quota.json"), "utf8")).retry_at - before;
      assert.ok(retry > 3597 && retry <= 3603, String(retry));
      db.prepare("INSERT INTO gen_metadata VALUES (2, ?)").run(generation("t2"));
      const next = await run(local); assert.equal(next.code, 0, next.err);
      assert.deepEqual(bodies.slice(2).map(b => b.messages.map(e => e.response_id)), [["t2"]]);
    } finally {
      db.close(); await new Promise(resolve => proxy.close(resolve));
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

// Scan/upload/checkpoint scenarios against a fake ingest server.
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
  const statePath = path.join(home, ".cache", "ai-activity", "antigravity.json");
  /** This target's checkpoints; the whole file (raw); replacing the file. */
  const state = () => targetOffsets(statePath, env.AI_ACTIVITY_URL, env.AI_ACTIVITY_KEY);
  const raw = () => fs.readFileSync(statePath, "utf8");
  const writeFile = (value) => fs.writeFileSync(statePath, JSON.stringify(value));
  const writeState = (value) => writeFile({ targets: { [collectorTarget(env.AI_ACTIVITY_URL, env.AI_ACTIVITY_KEY)]: value } });
  const collect = async (setup = "") => {
    const script = path.join(home, "scan-test.py");
    fs.writeFileSync(script, `import importlib.util, time\nspec = importlib.util.spec_from_file_location('collector', ${JSON.stringify(SCRIPT)})\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\n` +
      setup + "try:\n m.collect()\nexcept Exception:\n import traceback\n traceback.print_exc()\n raise SystemExit(1)\n");
    return run(env, [], "", null, script);
  };
  return { add, state, raw, writeFile, writeState, env, collect, accepted, batches, dir, home, refuse: value => refuse = value,
    close: async () => { await new Promise(resolve => proxy.close(resolve)); fs.rmSync(home, { recursive: true, force: true }); } };
}

test("large step tables are streamed and date generations without their own timestamp", async () => {
  const f = await scanFixture();
  try {
    f.add("large", [generation("first"), generation("matched", { when: null, step: "unique", bot: "unique" })],
      [...Array.from({ length: 20 }, () => bytes(127, Buffer.alloc(1000))),
        Buffer.concat([bytes(1, stamp(WHEN + 60)), bytes(12, "unique"), bytes(9, bytes(7, "unique"))])]);
    f.refuse(true); assert.equal((await f.collect()).code, 1);
    assert.equal(f.accepted.size, 0);
    f.refuse(false); assert.equal((await f.collect()).code, 0);
    assert.equal(f.accepted.size, 2);
    assert.equal(f.accepted.get("large:matched").occurred_at, WHEN + 60);
    const calls = f.batches.length;
    assert.equal((await f.collect()).code, 0); assert.equal(f.batches.length, calls);
  } finally { await f.close(); }
});

test("ambiguous step keys stay undated and duplicate responses upload once with final counts", async () => {
  const f = await scanFixture();
  try {
    f.add("dupes", [generation("final", { output: 80 }),
      generation("ambiguousA", { when: null, step: "shared", bot: "shared" }),
      generation("final", { output: 20 }),
      generation("ambiguousB", { when: null, step: "shared", bot: "shared" })],
    [Buffer.concat([bytes(1, stamp(WHEN + 60)), bytes(12, "shared"), bytes(9, bytes(7, "shared"))])]);
    for (let i = 0; i < 2; i++) assert.equal((await f.collect()).code, 0);
    assert.equal(f.accepted.size, 1); assert.equal(f.batches.length, 1);
    assert.equal(f.accepted.get("dupes:final").usage.output_tokens, 110);
  } finally { await f.close(); }
});

test("unchanged sources skip SQLite scans; old-row WAL edits invalidate stamps", async () => {
  const f = await scanFixture();
  let db;
  try {
    f.add("wal", [generation("old")]);
    db = new Database(path.join(f.dir, "wal.db")); db.pragma("journal_mode = WAL");
    db.prepare("UPDATE gen_metadata SET data=? WHERE idx=1").run(generation("old"));
    assert.equal((await f.collect()).code, 0);
    assert.equal(Object.keys(f.state().files).length, 1);
    const noScan = "m.read_database = lambda *args: (_ for _ in ()).throw(AssertionError('unchanged source scanned'))\n";
    assert.equal((await f.collect(noScan)).code, 0);
    const before = fs.statSync(path.join(f.dir, "wal.db")).mtimeMs;
    db.prepare("UPDATE gen_metadata SET data=? WHERE idx=1").run(generation("old", { output: 80 }));
    assert.equal(fs.statSync(path.join(f.dir, "wal.db")).mtimeMs, before, "change is in WAL only");
    assert.equal((await f.collect()).code, 0);
    assert.equal(f.accepted.get("wal:old").usage.output_tokens, 110);
    db.close(); db = null;
    assert.equal((await f.collect()).code, 0, "WAL disappearance also invalidates stamp");
  } finally { db?.close(); await f.close(); }
});

test("writes during a read cannot certify an unchanged snapshot", async () => {
  const f = await scanFixture();
  try {
    f.add("racing", [generation("first")]);
    const setup = `original = m.read_database\ndef racing(path):\n result = original(path)\n import sqlite3\n with sqlite3.connect(path) as db:\n  db.execute('INSERT INTO gen_metadata VALUES (2, ?)', (bytes.fromhex('${generation("second").toString("hex")}'),))\n return result\nm.read_database = racing\n`;
    assert.equal((await f.collect(setup)).code, 0);
    assert.equal(f.accepted.size, 1);
    assert.equal((await f.collect()).code, 0);
    assert.equal(f.accepted.size, 2);
  } finally { await f.close(); }
});

test("discovery excludes app-root databases and prunes checkpoints for deleted conversations", async () => {
  const f = await scanFixture();
  try {
    f.add("valid", [generation("valid")]);
    fs.copyFileSync(path.join(f.dir, "valid.db"), path.join(f.dir, "..", "decoy.db"));
    assert.equal((await f.collect()).code, 0);
    assert.equal(f.accepted.size, 1);
    fs.unlinkSync(path.join(f.dir, "valid.db"));
    assert.equal((await f.collect()).code, 0);
    assert.deepEqual(f.state().files, {});
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

test("first HTTP failure stops sources and quota probing; Retry-After delays retries", async () => {
  const f = await scanFixture();
  try {
    f.add("first", Array.from({ length: 250 }, (_, i) => generation(`response${i}`)));
    f.add("second", [generation("other")]);
    const setup = `import urllib.error\nimport urllib.request\nopen_original = urllib.request.OpenerDirector.open\ncalls = 0\ndef fail_second(self, *args, **kwargs):\n global calls\n calls += 1\n if calls == 2:\n  raise urllib.error.HTTPError('redacted', 429, 'limited', {'Retry-After': '120'}, None)\n return open_original(self, *args, **kwargs)\nurllib.request.OpenerDirector.open = fail_second\nm.os.environ['AI_ACTIVITY_ANTIGRAVITY_QUOTAS'] = '1'\nm.read_quotas = lambda: (_ for _ in ()).throw(AssertionError('quota probe after upload failure'))\n`;
    assert.equal((await f.collect(setup)).code, 1);
    assert.equal(f.accepted.size, 200);
    assert.equal(f.batches.length, 1);
    assert.ok(Object.values(f.state().files).every(entry => !entry.stamp));
    assert.equal((await f.collect()).code, 1);
    assert.equal(f.batches.length, 1, "Retry-After suppresses every upload");
    const noWait = "import time\noriginal_time = time.time\ntime.time = lambda: original_time() + 121\n";
    assert.equal((await f.collect(noWait)).code, 0);
    assert.equal(f.accepted.size, 251);
    assert.equal(f.batches.slice(1).flat().length, 51, "accepted batches are not sent again");
    assert.equal(Object.keys(f.state().files).length, 2);
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
      // Expire the previous delay before the next attempt.
      const stateFile = path.join(f.dir, "..", "..", "..", ".cache", "ai-activity", "antigravity.json");
      if (fs.existsSync(stateFile)) { const v = f.state(); delete v.upload_retry_at; f.writeState(v); }
      const before = Date.now() / 1000;
      assert.equal((await f.collect(setup)).code, 1);
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
      const result = await f.collect(setup);
      assert.equal(result.code, 1);
      assert.equal(f.batches.length, 0);
    }
  } finally { await f.close(); }
});


test("an actual HTTP redirect cannot forward the device bearer key", async () => {
  const f = await scanFixture();
  // Only a followed redirect reaches /api/ingest/antigravity with the key: test files run in
  // parallel, and a detached collector of another file may post to a
  // recycled port.
  let received = 0;
  const destination = http.createServer((request, response) => {
    if (request.url === "/api/ingest/antigravity" && request.headers.authorization === "Bearer test-key") received++;
    response.end('{}');
  });
  await new Promise(resolve => destination.listen(0, "127.0.0.1", resolve));
  const source = http.createServer((request, response) => {
    // 302: urllib follows it for a POST (as a GET, keeping Authorization);
    // it never follows a 307 POST, which would prove nothing.
    response.writeHead(302, { Location: `http://127.0.0.1:${destination.address().port}/api/ingest/antigravity` }); response.end();
  });
  await new Promise(resolve => source.listen(0, "127.0.0.1", resolve));
  try {
    f.add("redirect", [generation("one")]);
    const setup = `m.SERVER = 'http://127.0.0.1:${source.address().port}'\n`;
    assert.equal((await f.collect(setup)).code, 1);
    assert.equal(received, 0);
  } finally {
    await new Promise(resolve => source.close(resolve));
    await new Promise(resolve => destination.close(resolve));
    await f.close();
  }
});

test("a changed conversation re-sends only its new or grown responses", async () => {
  const f = await scanFixture();
  try {
    f.add("grow", [generation("a"), generation("b"), generation("c")]);
    assert.equal((await f.collect()).code, 0);
    assert.deepEqual(f.batches.map(b => b.length), [3]);
    const db = new Database(path.join(f.dir, "grow.db"));
    db.prepare("UPDATE gen_metadata SET data=? WHERE idx=2").run(generation("b", { output: 90 }));
    db.prepare("INSERT INTO gen_metadata VALUES (4, ?)").run(generation("d"));
    db.close();
    assert.equal((await f.collect()).code, 0);
    assert.deepEqual(f.batches[1].map(e => e.response_id).sort(), ["b", "d"]);
    assert.deepEqual(Object.values(f.state().files)[0].sent, { a: 50, b: 120, c: 50, d: 50 });
  } finally { await f.close(); }
});

test("malformed checkpoints start over instead of failing every run", async () => {
  const f = await scanFixture();
  try {
    f.add("state", [generation("one")]);
    assert.equal((await f.collect()).code, 0);
    const name = Object.keys(f.state().files)[0];
    for (const files of ["not an object", { [name]: 5 }, { [name]: { stamp: null, sent: { one: "x" } } }]) {
      f.writeState({ ...f.state(), files });
      const r = await f.collect(); assert.equal(r.code, 0, r.err);
      assert.equal(f.batches.at(-1)[0].response_id, "one", "the conversation is replayed");
      assert.deepEqual(Object.values(f.state().files)[0].sent, { one: 50 });
    }
  } finally { await f.close(); }
});

test("checkpoints are kept per server and key; the single-target shape of this target carries over", async () => {
  const f = await scanFixture();
  const sent = () => f.batches.splice(0).flat().map(e => e.response_id).sort();
  const collect = async (setup) => { const r = await f.collect(setup); assert.equal(r.code, 0, r.err); return sent(); };
  try {
    f.add("conv", [generation("one"), generation("two")]);
    assert.deepEqual(await collect(), ["one", "two"]);
    assert.deepEqual(await collect(), [], "an unchanged target sends nothing again");
    assert.deepEqual(await collect("m.KEY = 'other-key'\n"), ["one", "two"], "a new key gets the whole history");
    assert.deepEqual(await collect(`m.SERVER = ${JSON.stringify(f.env.AI_ACTIVITY_URL + "/")}\n`), [],
      "switching back resumes, whatever the trailing slash");
    assert.ok(!f.raw().includes("test-key") && !f.raw().includes("other-key"), "never the key");
    // Before targets, the file held one target: {"scope": sha256(url + "\n" + key), ...checkpoints}.
    const scope = createHash("sha256").update(`${f.env.AI_ACTIVITY_URL}\ntest-key`).digest("hex");
    f.writeFile({ scope, ...f.state() });
    assert.deepEqual(await collect(), [], "this target's checkpoints carry over");
    assert.deepEqual(Object.keys(JSON.parse(f.raw())), ["targets"]);
    f.writeFile({ scope: "0".repeat(64), ...f.state() });
    assert.deepEqual(await collect(), ["one", "two"], "another target's are dropped");
  } finally { await f.close(); }
});

test("unopenable databases are skipped until they change; busy ones fail the run and are retried",
  { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
    const f = await scanFixture();
    // A WAL database in a read-only directory cannot get its -shm file: permanent.
    const ide = path.join(f.home, ".gemini", "antigravity-ide", "conversations");
    try {
      fs.mkdirSync(ide, { recursive: true });
      const db = new Database(path.join(ide, "readonly.db")); db.pragma("journal_mode = WAL");
      db.exec("CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB)");
      db.prepare("INSERT INTO gen_metadata VALUES (1, ?)").run(generation("ro")); db.close();
      fs.chmodSync(ide, 0o555);
      f.add("ok", [generation("ok")]);
      const first = await f.collect(); assert.equal(first.code, 0, first.err);
      assert.match(first.err, /conversation database skipped until it changes/);
      assert.deepEqual([...f.accepted.keys()], ["ok:ok"]);
      assert.doesNotMatch((await f.collect()).err, /skipped/);
      const busy = "import sqlite3\nm.read_database = lambda path: (_ for _ in ()).throw(sqlite3.OperationalError('database is locked'))\n";
      f.add("later", [generation("later")]);
      const locked = await f.collect(busy); assert.equal(locked.code, 1); assert.match(locked.err, /busy; retry on next run/);
      assert.equal((await f.collect()).code, 0); assert.ok(f.accepted.has("later:later"));
    } finally { fs.chmodSync(ide, 0o755); await f.close(); }
  });

test("stamps change with the SQLite change counter and WAL salts, not only size and times", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-activity-stamp-"));
  try {
    const file = path.join(home, "stamp.db"), script = path.join(home, "stamp.py");
    const db = new Database(file); db.pragma("journal_mode = WAL"); db.exec("CREATE TABLE t(x)");
    fs.writeFileSync(script, `import importlib.util, json, pathlib, sys\nspec = importlib.util.spec_from_file_location('collector', ${JSON.stringify(SCRIPT)})\n` +
      `m = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nprint(json.dumps(m.file_stamp(pathlib.Path(${JSON.stringify(file)}))))\n`);
    const stamp = async () => JSON.parse((await run({}, [], "", null, script)).out);
    const [main, wal] = await stamp();
    assert.equal(main[4], fs.readFileSync(file).subarray(24, 28).toString("hex"));
    assert.equal(wal[4], fs.readFileSync(file + "-wal").subarray(16, 24).toString("hex"));
    db.close();
    assert.equal((await stamp())[1], null, "a missing WAL has no stamp");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
