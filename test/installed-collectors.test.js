// A device's actual install command, generated integration, collector and
// ingestion API in one path. A local HTTP receiver checks the wire format
// before forwarding accepted uploads to the real test server.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { COLLECTOR_VERSIONS } from "../shared/collectors.ts";
import { startServer, newDevice, req, processesGone, tempHome, PYTHON } from "./helpers.js";

const WINDOWS = process.platform === "win32";
const SECRET = "PRIVATE PROMPT MUST STAY LOCAL";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, ms = 30000) {
  const end = Date.now() + ms;
  do {
    if (await check()) return true;
    await sleep(100);
  } while (Date.now() < end);
  return false;
}

function run(command, env, input = "", shell = "powershell") {
  return new Promise((resolve, reject) => {
    const child = WINDOWS
      ? shell === "cmd"
        ? spawn(command, { env, shell: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
        : spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
          { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
      : spawn("sh", ["-c", command], { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (part) => { output += part; });
    child.stderr.on("data", (part) => { output += part; });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

function validateWire(tool, key, request, raw) {
  assert.equal(request.method, "POST");
  assert.equal(request.url, `/api/ingest/${tool}`);
  assert.equal(request.headers.authorization, `Bearer ${key}`);
  assert.match(request.headers["content-type"] ?? "", /^application\/json\b/i);
  assert.ok(!raw.includes(SECRET), "prompt content crossed the wire");
  assert.ok(!raw.includes('"PRIVATE_API_KEY"'), "provider key crossed the wire");
  assert.ok(!raw.includes("PRIVATE_EMAIL"), "quota account email crossed the wire");
  assert.ok(!raw.includes("PRIVATE_CREDENTIAL"), "quota credential crossed the wire");
  const body = JSON.parse(raw);
  assert.deepEqual(body.collector, { name: tool, version: COLLECTOR_VERSIONS[tool] });
  assert.ok(Array.isArray(body.messages));
  if (body.messages.length === 0) {
    assert.equal(tool, "antigravity");
    assert.ok(["gemini", "claude-gpt"].includes(body.account_ref));
    assert.equal(typeof body.rate_limits, "object");
    return body;
  }
  for (const message of body.messages) {
    assert.equal(typeof message.session_id, "string");
    assert.ok(message.session_id.length > 0);
    assert.equal(typeof message.occurred_at, "number");
    assert.ok(message.occurred_at > 0);
    assert.equal(typeof message.usage, "object");
    assert.ok(Number.isFinite(message.usage.input_tokens));
    assert.ok(Number.isFinite(message.usage.output_tokens));
    if (tool === "claude-code") {
      assert.equal(typeof message.message_id, "string");
      assert.equal(typeof message.model, "string");
    } else if (tool === "opencode") {
      assert.equal(typeof message.message_id, "string");
      assert.equal(typeof message.model_id, "string");
      assert.equal(typeof message.provider_id, "string");
    } else {
      assert.equal(typeof message.response_id, "string");
      assert.equal(typeof message.model, "string");
    }
  }
  return body;
}

async function receiver(upstream, tool, key) {
  const captured = [];
  const errors = [];
  let refused = 0;
  const server = http.createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const part of request) raw += part;
      const isUpload = request.method === "POST" && request.url === `/api/ingest/${tool}` && raw !== "{}";
      if (isUpload) {
        captured.push(validateWire(tool, key, request, raw));
        if (refused > 0) {
          refused--;
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "synthetic receiver failure" }));
          return;
        }
      }
      const upstreamResponse = await fetch(upstream + request.url, {
        method: request.method,
        headers: {
          ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
          ...(request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {}),
        },
        body: request.method === "GET" ? undefined : raw,
      });
      response.writeHead(upstreamResponse.status, { "content-type": upstreamResponse.headers.get("content-type") ?? "application/json" });
      response.end(Buffer.from(await upstreamResponse.arrayBuffer()));
    } catch (error) {
      errors.push(error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    captured,
    errors,
    refuseOnce: () => { refused++; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function fixture(tool, prepare) {
  const srv = await startServer();
  const key = (await newDevice(srv.base, `installed-${tool}`)).key;
  const home = tempHome(`ai-activity-installed-${tool}-`);
  const wire = await receiver(srv.base, tool, key);
  const old = { ...process.env };
  const env = {
    ...old, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"),
    GEMINI_CLI_HOME: path.join(home, ".gemini"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    AI_ACTIVITY_URL: wire.base, AI_ACTIVITY_KEY: key, AI_ACTIVITY_TOOLS: tool,
  };
  delete env.AI_ACTIVITY_ANTIGRAVITY_QUOTAS;
  // The plugin inherits process.env. Child processes must see the temporary
  // home and installed URL/key, never the developer's own tool settings.
  Object.assign(process.env, env);
  let resource;
  try {
    resource = await prepare({ home, env });
    const install = WINDOWS
      ? `irm ${srv.base}/install.ps1 | iex`
      : `curl -fsSL ${srv.base}/install.sh | sh`;
    const result = await run(install, env);
    assert.equal(result.code, 0, result.output);
    const summary = async () => (await req(srv.base, "GET", `/api/u/admin/summary?tool=${tool}`)).json.total;
    const sessions = async () => (await req(srv.base, "GET", `/api/u/admin/sessions?tool=${tool}`)).json.sessions;
    const quotas = async () => (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas.filter((q) => q.tool === tool);
    return { srv, home, env, wire, summary, sessions, quotas, resource, async close() {
      try {
        assert.ok(await processesGone(home), `detached ${tool} worker remained running`);
      } finally {
        await resource?.close?.();
        await wire.close();
        await srv.stop();
        fs.rmSync(home, { recursive: true, force: true });
        for (const name of Object.keys(process.env)) if (!(name in old)) delete process.env[name];
        Object.assign(process.env, old);
      }
    } };
  } catch (error) {
    await resource?.close?.();
    await wire.close();
    await srv.stop();
    fs.rmSync(home, { recursive: true, force: true });
    for (const name of Object.keys(process.env)) if (!(name in old)) delete process.env[name];
    Object.assign(process.env, old);
    throw error;
  }
}

function assertBatch(f, expected, count = 1) {
  const metrics = f.wire.captured.filter((body) => body.messages.length > 0);
  assert.equal(metrics.length, count);
  const [message] = metrics.at(-1).messages;
  assert.equal(metrics.at(-1).messages.length, 1);
  assert.equal(message.usage.input_tokens, expected.input);
  assert.equal(message.usage.output_tokens, expected.output);
  assert.equal(message.session_id, expected.session);
  assert.equal(message.message_id ?? message.response_id, expected.id);
}

test("installed Claude Code statusLine uploads one message and replays nothing", async () => {
  const f = await fixture("claude-code", ({ home }) => {
    const project = path.join(home, ".claude", "projects", "-fake");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "session.jsonl"), JSON.stringify({
      type: "assistant", sessionId: "claude-session", timestamp: new Date().toISOString(),
      message: { id: "msg_installed_claude", model: "claude-test",
        usage: { input_tokens: 12, output_tokens: 7 } },
    }) + "\n" + JSON.stringify({ type: "user", text: SECRET }) + "\n");
  });
  try {
    const command = JSON.parse(fs.readFileSync(path.join(f.home, ".claude", "settings.json"))).statusLine.command;
    f.wire.refuseOnce();
    assert.equal((await run(command, f.env, "{}", "cmd")).code, 0);
    assert.ok(await waitFor(() => f.wire.captured.length === 1));
    assert.ok(await processesGone(f.home));
    assert.equal((await f.summary()).events, 0, "failed upload did not advance progress");
    assert.equal((await run(command, f.env, "{}", "cmd")).code, 0);
    assert.ok(await waitFor(async () => (await f.summary()).events === 1), String(f.wire.errors[0] ?? "upload absent"));
    assert.ok(await processesGone(f.home));
    assertBatch(f, { input: 12, output: 7, session: "claude-session", id: "msg_installed_claude" }, 2);
    assert.deepEqual(f.wire.captured[0].messages, f.wire.captured[1].messages);
    assert.equal((await f.summary()).tokens, 19);
    assert.equal((await f.sessions())[0].model, "claude-test");
    assert.equal((await run(command, f.env, "{}", "cmd")).code, 0);
    assert.ok(await processesGone(f.home));
    assert.equal(f.wire.captured.length, 2);
    assert.equal((await f.summary()).tokens, 19);
  } finally { await f.close(); }
});

test("installed Codex Stop hook uploads a rollout and its quotas once", async () => {
  const session = "01a0b861-4cf4-7f10-8e5b-8d110992ee04";
  const f = await fixture("codex", ({ home }) => {
    const day = path.join(home, ".codex", "sessions", "2026", "09", "28");
    fs.mkdirSync(day, { recursive: true });
    const line = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload });
    const usage = { input_tokens: 20, cached_input_tokens: 0, cache_write_input_tokens: 0,
      output_tokens: 4, reasoning_output_tokens: 0, total_tokens: 24 };
    fs.writeFileSync(path.join(day, `rollout-2026-09-28T10-00-00-${session}.jsonl`), [
      line("session_meta", { id: session, session_id: session }),
      line("turn_context", { model: "gpt-test" }),
      line("response_item", { role: "user", content: [{ type: "input_text", text: SECRET }] }),
      line("token_usage_record", { thread_id: session, session_id: session, turn_id: "turn-1",
        response_id: "resp_installed_codex", usage }),
      line("event_msg", { type: "token_count",
        rate_limits: { primary: { used_percent: 11, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 },
          secondary: { used_percent: 22, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 86400 } },
        info: { last_token_usage: usage, total_token_usage: usage, model_context_window: 200000 } }),
    ].join("\n") + "\n");
  });
  try {
    const hooks = JSON.parse(fs.readFileSync(path.join(f.home, ".codex", "hooks.json"))).hooks;
    const command = hooks.Stop.at(-1).hooks[0].command;
    const runHook = () => run(command, f.env, JSON.stringify({ session_id: session, hook_event_name: "Stop" }));
    f.wire.refuseOnce();
    const first = await runHook();
    assert.equal(first.code, 0, first.output);
    assert.deepEqual(JSON.parse(first.output), {});
    assert.ok(await waitFor(() => f.wire.captured.length === 1));
    assert.ok(await processesGone(f.home));
    assert.equal((await f.summary()).events, 0);
    assert.equal((await runHook()).code, 0);
    assert.ok(await waitFor(async () => (await f.summary()).events === 1));
    assert.ok(await processesGone(f.home));
    assertBatch(f, { input: 20, output: 4, session, id: "resp_installed_codex" }, 2);
    assert.deepEqual(f.wire.captured[0].messages, f.wire.captured[1].messages);
    assert.equal((await f.summary()).tokens, 24);
    assert.equal((await f.sessions())[0].model, "gpt-test");
    assert.deepEqual((await f.quotas()).map((q) => [q.limit_type, q.used_pct]), [["five_hour", 11], ["seven_day", 22]]);
    assert.equal((await runHook()).code, 0);
    assert.ok(await processesGone(f.home));
    assert.equal(f.wire.captured.length, 2);
    assert.equal((await f.summary()).tokens, 24);
  } finally { await f.close(); }
});

test("installed OpenCode plugin uploads its SQLite message once", async () => {
  const f = await fixture("opencode", ({ home }) => {
    const dir = path.join(home, ".local", "share", "opencode");
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, "opencode.db"));
    db.exec(`CREATE TABLE session (id text PRIMARY KEY, parent_id text, title text NOT NULL, directory text NOT NULL);
      CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
        time_updated integer NOT NULL, data text NOT NULL);
      CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, data text NOT NULL);`);
    const now = Date.now();
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?)").run("ses_installed", null, SECRET, "/secret/path");
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
      "msg_installed", "ses_installed", now - 1000, now,
      JSON.stringify({ role: "assistant", providerID: "openai", modelID: "gpt-test",
        time: { created: now - 1000, completed: now },
        tokens: { input: 13, output: 6, reasoning: 0, cache: { read: 0, write: 0 }, total: 19 } }));
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run("part_installed", "msg_installed", "ses_installed",
      JSON.stringify({ type: "text", text: SECRET }));
    return { close: () => db.close() };
  });
  try {
    const plugin = path.join(f.home, ".config", "opencode", "plugins", "ai-activity.js");
    f.wire.refuseOnce();
    const hooks = await (await import(pathToFileURL(plugin).href)).AIActivity({});
    assert.ok(await waitFor(() => f.wire.captured.length === 1));
    assert.ok(await processesGone(f.home));
    assert.equal((await f.summary()).events, 0);
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_installed" } } });
    assert.ok(await waitFor(async () => (await f.summary()).events === 1));
    assert.ok(await processesGone(f.home));
    assertBatch(f, { input: 13, output: 6, session: "ses_installed", id: "msg_installed" }, 2);
    assert.deepEqual(f.wire.captured[0].messages, f.wire.captured[1].messages);
    assert.equal((await f.summary()).tokens, 19);
    assert.equal((await f.sessions())[0].model, "openai/gpt-test");
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_installed" } } });
    assert.ok(await processesGone(f.home));
    // OpenCode intentionally reads again from the accepted row's exact
    // millisecond so another message with that timestamp cannot be missed.
    assert.equal(f.wire.captured.length, 3);
    assert.equal(f.wire.captured[2].messages[0].message_id, "msg_installed");
    assert.equal((await f.summary()).tokens, 19);
  } finally { await f.close(); }
});

const varint = (n) => {
  const out = [];
  do { out.push((n & 127) | (n >= 128 ? 128 : 0)); n = Math.floor(n / 128); } while (n);
  return Buffer.from(out);
};
const integer = (key, n) => Buffer.concat([varint(key * 8), varint(n)]);
const bytes = (key, value) => {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint(key * 8 + 2), varint(data.length), data]);
};

function fakeAgy(home, env) {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  const now = Math.floor(Date.now() / 1000);
  const bucket = (id, remaining, seconds) => ({ id, remaining_fraction: remaining,
    reset_time: new Date((now + seconds) * 1000).toISOString() });
  const report = { status: "SUCCESS", command: { name: "usage", data: {
    email: "PRIVATE_EMAIL", groups: [
      { display_name: "Gemini Models", buckets: [
        bucket("gemini-5h", 0.75, 3600), bucket("gemini-weekly", 0.5, 86400)] },
      { display_name: "Claude and GPT models", buckets: [
        bucket("3p-5h", 1, 7200), bucket("3p-weekly", 0.3, 172800)] },
    ],
  } }, credential: "PRIVATE_CREDENTIAL" };
  fs.writeFileSync(path.join(bin, "agy.json"), JSON.stringify(report));
  const program = `import json, pathlib, sys
here = pathlib.Path(__file__).resolve().parent
if sys.argv[1:] == ["--version"]:
 print("1.1.11")
else:
 print((here / "agy.json").read_text())
`;
  if (WINDOWS) {
    fs.writeFileSync(path.join(bin, "fake-agy.py"), program);
    fs.writeFileSync(path.join(bin, "agy.cmd"), `@"${PYTHON}" "%~dp0fake-agy.py" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, "agy"), `#!/usr/bin/env python3\n${program}`, { mode: 0o755 });
  }
  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = bin + path.delimiter + (env[pathKey] ?? "");
  env.AI_ACTIVITY_ANTIGRAVITY_QUOTAS = "1";
}

test("installed Antigravity hook uploads its conversation once", async () => {
  const f = await fixture("antigravity", ({ home, env }) => {
    fakeAgy(home, env);
    const dir = path.join(home, ".gemini", "antigravity-cli", "conversations");
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, "installed.db"));
    db.exec("CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY, metadata BLOB)");
    const now = Math.floor(Date.now() / 1000) - 60;
    const usage = Buffer.concat([integer(1, 10), integer(2, 100), integer(5, 500), integer(9, 20),
      integer(10, 30), bytes(11, "response_installed"), bytes(7, "bot1")]);
    const blob = Buffer.concat([bytes(1, Buffer.concat([bytes(4, usage), bytes(19, "gemini-test"),
      bytes(9, bytes(4, integer(1, now)))])), bytes(4, "step1")]);
    db.prepare("INSERT INTO gen_metadata VALUES (1, ?)").run(blob);
    return { close: () => db.close() };
  });
  try {
    const config = JSON.parse(fs.readFileSync(path.join(f.home, ".gemini", "config", "hooks.json")));
    const command = config["ai-activity"].Stop[0].command;
    const runHook = () => run(command, f.env, JSON.stringify({ conversationId: "installed", transcriptPath: SECRET }), "cmd");
    f.wire.refuseOnce();
    const first = await runHook();
    assert.equal(first.code, 0, first.output);
    assert.deepEqual(JSON.parse(first.output), { decision: "stop" });
    assert.ok(await waitFor(() => f.wire.captured.length === 1));
    assert.ok(await processesGone(f.home));
    assert.equal((await f.summary()).events, 0);
    assert.equal((await runHook()).code, 0);
    assert.ok(await waitFor(async () => (await f.summary()).events === 1));
    assert.ok(await processesGone(f.home));
    assertBatch(f, { input: 110, output: 50, session: "installed", id: "response_installed" }, 2);
    assert.deepEqual(f.wire.captured[0].messages, f.wire.captured[1].messages);
    assert.equal((await f.summary()).tokens, 660);
    assert.equal((await f.sessions())[0].model, "gemini-test");
    assert.deepEqual((await f.quotas()).map((q) => [q.account_ref, q.limit_type, q.used_pct]),
      [["claude-gpt", "five_hour", 0], ["claude-gpt", "seven_day", 70],
        ["gemini", "five_hour", 25], ["gemini", "seven_day", 50]]);
    assert.deepEqual(f.wire.captured.filter((body) => body.messages.length === 0)
      .map((body) => body.account_ref).sort(), ["claude-gpt", "gemini"]);
    assert.equal((await runHook()).code, 0);
    assert.ok(await processesGone(f.home));
    assert.equal(f.wire.captured.length, 4);
    assert.equal((await f.summary()).tokens, 660);
  } finally { await f.close(); }
});
