// Runs the Codex collector (collectors/codex.py) through the Stop hook
// command printed in README.md, against a real server, with fake rollouts in
// a temporary HOME.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { startServer, req, newDevice, asNewClient } from "./helpers.js";

const README = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
const hooks = JSON.parse(README.match(/`~\/\.codex\/hooks\.json`:\n\n```json\n([\s\S]*?)\n```/)[1]);
const hookCommand = hooks.hooks.Stop[0].hooks[0].command;
const submitCommand = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
const SCRIPT = fs.readFileSync(new URL("../collectors/codex.py", import.meta.url), "utf8");

// Recent times: a quota window is only kept if it resets within its length of the measurement.
const START = Date.now() - 3600 * 1000;
let seq = 0;
const stamp = () => new Date(START + 1000 * seq++).toISOString();
const line = (type, payload) => JSON.stringify({ timestamp: stamp(), type, payload });
const usage = (input, cached, output) =>
  ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
const NOW = () => Math.floor(Date.now() / 1000);
const limits = (five) => ({
  limit_id: "codex", primary: { used_percent: five, window_minutes: 300, resets_at: NOW() + 3600 },
  secondary: { used_percent: 40, window_minutes: 10080, resets_at: NOW() + 86400 }, plan_type: "plus",
});
const tokenCount = (last, total, five) => line("event_msg", {
  type: "token_count", rate_limits: limits(five),
  info: { last_token_usage: last, total_token_usage: { ...last, total_tokens: total }, model_context_window: 200000 },
});
/** One response in a current rollout: token_usage_record, then its token_count. */
function response(id, session, u, total, five = 10) {
  return [
    line("token_usage_record", { thread_id: session, session_id: session, turn_id: "turn-1", response_id: id, usage: u,
      thread_token_usage: { ...u, total_tokens: total } }),
    tokenCount(u, total, five),
  ].join("\n") + "\n";
}
const secret = () => line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "secret prompt" }] }) + "\n";

/** Run a shell command in its own process group; resolves with its stdout. */
function run(cmd, env) {
  return new Promise((resolve) => {
    const p = spawn("sh", ["-c", cmd], { env, detached: true, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stdin.on("error", () => {}); // the hook may exit before reading its input (EPIPE)
    p.stdin.end(JSON.stringify({ session_id: "s", hook_event_name: "Stop", turn_id: "t" }));
    p.on("exit", () => resolve(out));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}

describe("Codex collector (Stop hook from README.md)", () => {
  let srv, key, home, env, current, legacy;
  const S1 = "01a0b861-4cf4-7f10-8e5b-8d110992ee04";
  const S0 = "019e0073-fee0-7000-8000-000000000000";
  const summary = async () => (await req(srv.base, "GET", "/api/u/admin/summary?tool=codex", { headers: asNewClient() })).json.total;
  const install = (server) => fs.writeFileSync(path.join(home, ".codex", "ai-activity-codex.py"),
    SCRIPT.replace("<server>", server).replace("<device key>", key));
  const state = () => JSON.parse(fs.readFileSync(path.join(home, ".cache", "ai-activity", "codex.json"), "utf8"));

  before(async () => {
    srv = await startServer();
    key = (await newDevice(srv.base, "codex-collector")).key;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-activity-codex-"));
    env = { ...process.env, HOME: home, CODEX_HOME: "", TZ: "IST-5:30" }; // POSIX TZ: UTC+5:30, no tz database needed
    const day = path.join(home, ".codex", "sessions", "2026", "09", "20");
    fs.mkdirSync(day, { recursive: true });
    fs.mkdirSync(path.join(home, ".codex", "archived_sessions"), { recursive: true });
    current = path.join(day, `rollout-2026-09-20T10-00-00-${S1}.jsonl`);
    fs.writeFileSync(current, [
      line("session_meta", { id: S1, session_id: S1, originator: "Codex Desktop", cli_version: "0.153.4" }),
      line("turn_context", { turn_id: "turn-1", model: "gpt-6-astra" }),
    ].join("\n") + "\n" + secret() +
      response("resp_1", S1, usage(1000, 800, 50), 1050) +
      tokenCount(usage(1000, 800, 50), 1050, 10) + "\n" + // repeated token_count: not a response
      response("resp_2", S1, usage(2000, 1500, 100), 3150, 12) +
      "{broken\n" +
      line("token_usage_record", { session_id: S1, response_id: "resp_half" })); // still being written
    // Written before Codex had token_usage_record: token_count only, sometimes repeated.
    legacy = path.join(home, ".codex", "archived_sessions", `rollout-2026-05-07T05-21-02-${S0}.jsonl`);
    fs.writeFileSync(legacy, [
      line("session_meta", { id: S0, originator: "codex_vscode", cli_version: "0.128.0" }),
      line("turn_context", { model: "gpt-5.5" }),
      line("event_msg", { type: "token_count", info: null, rate_limits: limits(1) }),
      tokenCount(usage(500, 0, 20), 520, 2),
      tokenCount(usage(500, 0, 20), 520, 2),
      tokenCount(usage(700, 500, 30), 1250, 3),
    ].join("\n") + "\n");
  });
  after(() => {
    srv.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("first run sends every response once, detached, and answers the hook at once", async () => {
    install(srv.base);
    const out = await run(hookCommand, env);
    assert.deepEqual(JSON.parse(out), {}, "the hook prints valid JSON for Codex");
    assert.ok(await waitFor(async () => (await summary()).events === 4), "4 responses stored");
    const t = await summary();
    assert.equal(t.tokens, 1050 + 2100 + 520 + 730);
    assert.deepEqual(t.by_model.map((x) => x.name).sort(), ["gpt-5.5", "gpt-6-astra"]);
    const q = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas.filter((x) => x.tool === "codex");
    assert.deepEqual(q.map((x) => [x.limit_type, x.used_pct]), [["five_hour", 12], ["seven_day", 40]]);
    const s = (await req(srv.base, "GET", "/api/u/admin/sessions?tool=codex")).json.sessions.find((x) => x.session_id === S1);
    assert.equal(s.context_used_pct, 1.1); // the last request: 2100 of 200000 tokens
    assert.equal(s.model, "gpt-6-astra");
    // Each entry carries the device's UTC offset at that time, in minutes.
    const db = new Database(srv.dbPath, { readonly: true });
    const utcOffsets = db.prepare("SELECT DISTINCT utc_offset_min AS o FROM usage_events").all().map((r) => r.o);
    db.close();
    assert.deepEqual(utcOffsets, [330]);
    // The offset stops before the half-written line.
    const complete = fs.readFileSync(current).lastIndexOf(10) + 1;
    assert.ok(await waitFor(() => state()[current]?.[0] === complete), "the offset stops before the half-written line");
  });

  test("later runs send only what was added", async () => {
    const before = await summary();
    await run(hookCommand, env);
    await sleep(1000);
    assert.equal((await summary()).tokens, before.tokens);
    fs.appendFileSync(current, "\n" + secret().repeat(500) + response("resp_3", S1, usage(3000, 2900, 10), 6160));
    await run(hookCommand, env);
    assert.ok(await waitFor(async () => (await summary()).events === before.events + 1));
    assert.equal((await summary()).tokens - before.tokens, 3010);
  });

  test("nothing is lost while the server is down", async () => {
    const before = await summary();
    const saved = state();
    fs.appendFileSync(current, response("resp_4", S1, usage(100, 0, 5), 6265));
    install("http://127.0.0.1:9");
    await run(hookCommand, env);
    await sleep(1500);
    assert.deepEqual(state(), saved);
    install(srv.base);
    // Two runs at once: the second waits for the lock, nothing is sent twice.
    await Promise.all([run(hookCommand, env), run(hookCommand, env)]);
    assert.ok(await waitFor(async () => (await summary()).events === before.events + 1));
    await sleep(1000);
    assert.equal((await summary()).tokens - before.tokens, 105);
  });

  test("a line with an unreadable timestamp is skipped, not retried forever", async () => {
    const before = await summary();
    const bad = JSON.stringify({ timestamp: "not a date", type: "token_usage_record",
      payload: { session_id: S1, response_id: "resp_bad", usage: usage(9, 0, 9) } });
    fs.appendFileSync(current, bad + "\n" + response("resp_5", S1, usage(200, 100, 7), 6472));
    await run(hookCommand, env);
    assert.ok(await waitFor(async () => (await summary()).events === before.events + 1));
    assert.equal((await summary()).tokens - before.tokens, 207);
    // The detached collector saves its offsets after the server answered.
    assert.ok(await waitFor(() => state()[current]?.[0] === fs.statSync(current).size), "the offset moves past the bad line");
  });

  test("a run cut short keeps the files already sent", async () => {
    const before = await summary();
    const day = path.join(home, ".codex", "sessions", "2026", "09", "21");
    fs.mkdirSync(day, { recursive: true });
    const good = path.join(day, "rollout-2026-09-21T10-00-00-good.jsonl");
    const rejected = path.join(day, "rollout-2026-09-21T11-00-00-rejected.jsonl");
    fs.writeFileSync(good, line("session_meta", { id: "s-good" }) + "\n" + response("resp_6", "s-good", usage(40, 0, 2), 42));
    // A session id past the 256 KB body limit: the server answers 413 for this file.
    const huge = "x".repeat(300 * 1024);
    fs.writeFileSync(rejected, line("session_meta", { id: huge }) + "\n" + response("resp_7", huge, usage(1, 0, 1), 2));
    await run(hookCommand, env);
    assert.ok(await waitFor(() => fs.existsSync(path.join(home, ".cache")) && state()[good]), "the accepted file is saved");
    assert.equal(state()[good][0], fs.statSync(good).size);
    assert.equal(state()[rejected], undefined, "the rejected file is retried next run");
    assert.equal((await summary()).tokens - before.tokens, 42);
    fs.rmSync(rejected);
  });

  test("no prompt text is sent", () => {
    // The collector only builds messages from token records; nothing else is read into a payload.
    assert.ok(!/content|last_agent_message|text/.test(SCRIPT.match(/messages\.append\(\{[\s\S]*?\}\)/g).join("")));
  });

  test("a limit snapshot without token counts is still posted", async () => {
    // A failed turn records its quota with no usage: the exhausted window's
    // final value must reach the server even though no message is stored.
    const before = await summary();
    fs.appendFileSync(current, line("event_msg", { type: "rate_limits", rate_limits: limits(100) }) + "\n");
    await run(hookCommand, env);
    const quotas = async () => (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas.filter((x) => x.tool === "codex");
    assert.ok(await waitFor(async () =>
      (await quotas()).some((x) => x.limit_type === "five_hour" && x.used_pct === 100)));
    assert.deepEqual((await quotas()).map((x) => [x.limit_type, x.used_pct]),
      [["five_hour", 100], ["seven_day", 40]]);
    assert.equal((await summary()).events, before.events, "no usage stored from a snapshot-only run");
  });

  test("the UserPromptSubmit backstop runs the same script and answers the hook", async () => {
    const before = await summary();
    const out = await run(submitCommand, env);
    assert.deepEqual(JSON.parse(out), {}, "the hook prints valid JSON for Codex");
    await sleep(1000);
    assert.equal((await summary()).tokens, before.tokens, "nothing new: the run is a no-op");
  });
});
