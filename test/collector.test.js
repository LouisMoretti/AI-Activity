// Runs the Claude Code collector (collectors/claude-code.py) through the
// hook and statusLine commands printed in README.md (the Windows ones on
// Windows), against a real server, with fake transcripts in a temporary HOME.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { startServer, req, newDevice, asNewClient, running, PYTHON, tempHome, targetOffsets, collectorTarget, recordingServer } from "./helpers.js";

const WINDOWS = process.platform === "win32";
const README = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const section = README.split("## Send Claude Code usage from a device")[1].split("## Send Codex")[0];
const [posix, windows] = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(`{${m[1]}}`));
const commands = (settings) => {
  const hooks = new Set(Object.values(settings.hooks).map((entries) => JSON.stringify(entries[0].hooks[0])));
  assert.equal(hooks.size, 1, "every hook runs the same command");
  const handler = JSON.parse([...hooks][0]);
  return { hook: handler.args ? handler : handler.command, statusLine: settings.statusLine.command };
};
const SCRIPT = fs.readFileSync(new URL("../collectors/claude-code.py", import.meta.url), "utf8");
// The README's commands name the interpreter and ~ or C:\Users\<user>: run
// them with this test's interpreter on this test's copy instead.
const [README_COMMANDS, PREFIX] = WINDOWS
  ? [commands(windows), 'python "C:\\Users\\<user>\\.claude\\ai-activity-claude-code.py"']
  : [commands(posix), "python3 ~/.claude/ai-activity-claude-code.py"];

let line = 0;
const entry = (id, output, { session = "sess-1", agent = null } = {}) =>
  JSON.stringify({
    type: "assistant", sessionId: session, agentId: agent,
    timestamp: new Date(Date.UTC(2026, 8, 20, 10, 0, line++)).toISOString(),
    message: { id, model: "claude-opus-5-5", content: [{ type: "text", text: "secret reply" }],
      usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: output } },
  });
const PER_MESSAGE = 2 + 100 + 1000;
const filler = (n) => Array.from({ length: n }, () => JSON.stringify({ type: "user", message: { content: "secret prompt" } })).join("\n") + "\n";

/**
 * Run a shell command with stdin in its own process group; optionally kill
 * that group early. Windows has no process groups: there it runs through
 * cmd.exe and the kill ends that shell, as cancelling a command does. (A
 * tree kill landing before the launcher returned would take the upload with
 * it: that refresh is then sent by the next one.)
 */
function run(cmd, { stdin = "{}", env, killAfterMs } = {}) {
  return new Promise((resolve) => {
    const p = typeof cmd === "object"
      ? spawn(cmd.command, cmd.args, { env, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] })
      : WINDOWS
      ? spawn(cmd, { env, shell: true, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] })
      : spawn("sh", ["-c", cmd], { env, detached: true, stdio: ["pipe", "ignore", "ignore"] });
    p.stdin.on("error", () => {}); // killed before reading its input (EPIPE)
    p.stdin.end(stdin);
    const kill = () => {
      try {
        if (WINDOWS) p.kill();
        else process.kill(-p.pid, "SIGKILL");
      } catch { /* exited */ }
    };
    if (killAfterMs !== undefined) setTimeout(kill, killAfterMs);
    p.on("exit", resolve);
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

/**
 * Collectors run detached, so a refresh's command returns before its upload
 * ends. Wait until none is left: one still queued on the lock would
 * otherwise read what the next test appends and move its offsets (issue
 * #123). The script's path (in this test's HOME) is on its command line.
 */
async function collectorsDone(marker) {
  assert.ok(await waitFor(() => !running(marker), 30000), "a detached collector from an earlier refresh is still running");
}

/** Forwards to the server after delayMs, so an upload is still in flight when its group is killed. */
function slowProxy(target, delayMs) {
  const server = http.createServer((inReq, inRes) => {
    const chunks = [];
    inReq.on("data", (c) => chunks.push(c));
    inReq.on("end", async () => {
      await sleep(delayMs);
      const out = http.request(target + inReq.url, { method: inReq.method, headers: inReq.headers }, (res) => {
        inRes.writeHead(res.statusCode, res.headers);
        res.pipe(inRes);
      });
      out.end(Buffer.concat(chunks));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

describe("Claude Code collector (hooks and statusLine from README.md)", () => {
  let srv, key, home, env, proxy, project, transcript, marker, installed;
  const stats = async () => (await req(srv.base, "GET", "/api/u/admin/stats?days=730", { headers: asNewClient() })).json;
  const scriptPath = () => path.join(home, ".claude", "ai-activity-claude-code.py");
  /** The hook command (tokens), or the statusLine one (quotas), with the installed copy posting to `base` with `k`. */
  const cmd = (base, k = key, which = "hook") => {
    // Rewritten only when the server or key changes: never under a run starting.
    if (installed !== `${base}\n${k}`) fs.writeFileSync(scriptPath(), SCRIPT.replace("<server>", base).replace("<device key>", k));
    installed = `${base}\n${k}`;
    if (typeof README_COMMANDS[which] === "object") {
      assert.deepEqual(README_COMMANDS[which].args, ['C:\\Users\\<user>\\.claude\\ai-activity-claude-code.py', "--hook"]);
      return { command: PYTHON, args: [scriptPath(), "--hook"] };
    }
    assert.ok(README_COMMANDS[which].startsWith(PREFIX));
    return README_COMMANDS[which].replace(PREFIX, `"${PYTHON}" "${scriptPath()}"`);
  };
  const statusLine = (base = srv.base) => cmd(base, key, "statusLine");
  const hookInput = JSON.stringify({ hook_event_name: "Stop", session_id: "sess-1", transcript_path: "/secret/path" });
  const viaProxy = () => cmd(`http://127.0.0.1:${proxy.address().port}`);
  const offsetsFile = () => path.join(home, ".cache", "ai-activity", "offsets.json");
  /** The whole offsets file, and the offsets of one server and key in it. */
  const saved = () => fs.readFileSync(offsetsFile(), "utf8");
  const offsets = (base = srv.base, k = key) => targetOffsets(offsetsFile(), base, k);

  before(async () => {
    srv = await startServer();
    key = (await newDevice(srv.base, "collector")).key;
    proxy = await slowProxy(srv.base, 1500);
    home = tempHome("ai-activity-home-");
    marker = scriptPath();
    const { AI_ACTIVITY_URL, AI_ACTIVITY_KEY, ...inherited } = process.env; // the command says where
    // POSIX TZ (Windows reads it too): UTC+5:30, no tz database needed.
    env = { ...inherited, HOME: home, USERPROFILE: home, TZ: "IST-5:30" };
    project = path.join(home, ".claude", "projects", "-work");
    fs.mkdirSync(path.join(project, "sess-1", "subagents"), { recursive: true });
    transcript = path.join(project, "sess-1.jsonl");
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: "user", message: { content: "secret prompt" } }),
      entry("msg_a", 3), // partial…
      entry("msg_a", 983), // …then final: counted once, with 983
      entry("msg_b", 10),
      "{not json",
      entry("msg_c", 20) + entry("msg_d", 30), // two objects written on one line
      "",
    ].join("\n") + entry("msg_half", 1)); // no trailing newline: still being written
    fs.writeFileSync(path.join(project, "sess-1", "subagents", "agent-x.jsonl"), entry("msg_sub", 16, { agent: "x" }) + "\n");
  });
  beforeEach(() => collectorsDone(marker));
  after(async () => {
    try {
      await collectorsDone(marker);
    } finally {
      // Clean up even if a collector is stuck, so its failure is the one reported.
      await new Promise((r) => proxy.close(r));
      srv.stop();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("first hook sends every message once, even when its process group is killed mid-upload", async () => {
    // Claude Code may cancel a hook. The proxy holds the upload for 1.5 s,
    // so without detaching the kill always lands mid-upload.
    await run(viaProxy(), { stdin: hookInput, env, killAfterMs: 300 });
    assert.ok(await waitFor(async () => (await stats()).events === 5), "the detached upload finished despite the kill");
    assert.equal((await stats()).total_tokens, 5 * PER_MESSAGE + 983 + 10 + 20 + 30 + 16);
    assert.equal((await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas.length, 0, "a hook sends no quotas");
    // Each entry carries the device's UTC offset at that time, in minutes.
    const db = new Database(srv.dbPath, { readonly: true });
    const utcOffsets = db.prepare("SELECT DISTINCT utc_offset_min AS o FROM usage_events").all().map((r) => r.o);
    db.close();
    assert.deepEqual(utcOffsets, [330]);
    // Offsets stop before the half-written line. They are saved after the
    // server answered, so the events can show up first.
    await collectorsDone(marker);
    assert.equal(offsets(`http://127.0.0.1:${proxy.address().port}`)[transcript], fs.readFileSync(transcript).lastIndexOf(10) + 1);
  });

  test("later refreshes send only what was added, however long", async () => {
    const before = await stats();
    await run(cmd(srv.base), { env });
    // Let the detached upload finish: the check then means something, and
    // the append below cannot race this collector.
    await collectorsDone(marker);
    assert.equal((await stats()).total_tokens, before.total_tokens);
    // Finish the half-written line, then write far more than any tail window.
    fs.appendFileSync(transcript, "\n" + filler(1000) + entry("msg_late", 5) + "\n");
    await run(cmd(srv.base), { env });
    assert.ok(await waitFor(async () => (await stats()).events === before.events + 2));
    assert.equal((await stats()).total_tokens - before.total_tokens, 2 * PER_MESSAGE + 1 + 5);
  });

  test("nothing is lost while the server is down", async () => {
    const before = await stats();
    const file = saved();
    fs.appendFileSync(transcript, entry("msg_offline", 7) + "\n");
    await run(cmd("http://127.0.0.1:9"), { env });
    // The failed run saves nothing: wait until it is gone, then the
    // unchanged offsets mean something.
    await collectorsDone(marker);
    assert.equal(saved(), file);
    // Two refreshes at once: the second waits for the lock, nothing is sent twice.
    await Promise.all([run(cmd(srv.base), { env }), run(cmd(srv.base), { env })]);
    assert.ok(await waitFor(async () => (await stats()).events === before.events + 1));
    // The events show up before the detached uploads saved their offsets.
    await collectorsDone(marker);
    assert.equal((await stats()).total_tokens - before.total_tokens, PER_MESSAGE + 7);
  });

  test("the status line posts quotas and context, never the transcripts", async () => {
    const before = await stats();
    const file = saved();
    fs.appendFileSync(transcript, entry("msg_hook_only", 4) + "\n");
    const refresh = (pct) => run(statusLine(), { env, stdin: JSON.stringify({
      session_id: "sess-1", transcript_path: transcript,
      rate_limits: { five_hour: { used_percentage: pct, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
      context_window: { used_percentage: 37, context_window_size: 200000 },
    }) });
    await refresh(21);
    const quota = (pct) => async () => (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas
      .some((x) => x.limit_type === "five_hour" && x.used_pct === pct);
    assert.ok(await waitFor(quota(21)));
    const s = (await req(srv.base, "GET", "/api/u/admin/sessions")).json.sessions.find((x) => x.session_id === "sess-1");
    assert.equal(s.context_used_pct, 37);
    // An exhausted quota records its final value.
    await refresh(100);
    assert.ok(await waitFor(quota(100)));
    await collectorsDone(marker);
    assert.equal((await stats()).total_tokens, before.total_tokens, "no usage from the status line");
    assert.equal(saved(), file, "the status line leaves the offsets alone");
    await run(cmd(srv.base), { stdin: hookInput, env });
    assert.ok(await waitFor(async () => (await stats()).events === before.events + 1), "the next hook sends it");
  });

  test("the status line does not post the same values again within 5 minutes", async () => {
    const rec = await recordingServer();
    const refresh = async (pct, k = key) => {
      await run(cmd(rec.base, k, "statusLine"), { env, stdin: JSON.stringify({
        session_id: "sess-1", rate_limits: { five_hour: { used_percentage: pct, resets_at: 1999999999 } },
      }) });
      await collectorsDone(marker);
      return rec.batches.splice(0).length;
    };
    try {
      assert.equal(await refresh(40), 1);
      assert.equal(await refresh(40), 0, "unchanged: not posted again");
      assert.equal(await refresh(40, "ak_other"), 1, "another key gets its own report");
      assert.equal(await refresh(40), 0, "returning to the first key keeps its five-minute window");
      assert.equal(await refresh(41), 1, "changed: posted at once");
      // Five minutes later, the same values are posted again.
      const file = path.join(home, ".cache", "ai-activity", "status.json");
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      const fp = collectorTarget(rec.base, key);
      saved.targets[fp].at = Math.floor(Date.now() / 1000) - 301;
      fs.writeFileSync(file, JSON.stringify(saved));
      assert.equal(await refresh(41), 1);
    } finally {
      cmd(srv.base);
      await rec.close();
    }
  });

  test("context uploaded before the first transcript survives the status cache", async () => {
    const session = "status-before-tokens";
    await run(statusLine(), { env, stdin: JSON.stringify({
      session_id: session, context_window: { used_percentage: 37, context_window_size: 200000 },
    }) });
    await collectorsDone(marker);
    fs.writeFileSync(path.join(project, session + ".jsonl"), entry("msg_context_first", 20, { session }) + "\n");
    // No second status refresh: the hook must recover the earlier observation.
    await run(cmd(srv.base), { env });
    await collectorsDone(marker);
    const row = (await req(srv.base, "GET", "/api/u/admin/sessions")).json.sessions.find((s) => s.session_id === session);
    assert.equal(row.context_used_pct, 37);
    assert.equal(row.context_window_size, 200000);
  });

  test("a refused status report is retried on the next refresh", async () => {
    let attempts = 0;
    const endpoint = http.createServer(async (request, response) => {
      for await (const chunk of request) void chunk;
      attempts++;
      response.writeHead(attempts === 1 ? 429 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${endpoint.address().port}`;
    const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 88, resets_at: 1999999999 } } });
    const refresh = async () => {
      await run(statusLine(base), { env, stdin: input });
      await collectorsDone(marker);
    };
    try {
      await refresh();
      assert.equal(attempts, 1);
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, ".cache", "ai-activity", "status.json"), "utf8"))
        .targets?.[collectorTarget(base, key)]?.seen, undefined, "429 does not mark the status as sent");
      await refresh();
      assert.equal(attempts, 2, "the same status is retried");
    } finally {
      cmd(srv.base);
      await new Promise((resolve) => endpoint.close(resolve));
    }
  });

  test("busy status refreshes coalesce and send the final observation without another refresh", async () => {
    const received = [];
    let releaseFirst;
    const firstDone = new Promise((resolve) => { releaseFirst = resolve; });
    const endpoint = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received.push(JSON.parse(Buffer.concat(chunks).toString()).rate_limits.five_hour.used_percentage);
      if (received.length === 1) await firstDone;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${endpoint.address().port}`;
    const refresh = (pct) => run(statusLine(base), { env, stdin: JSON.stringify({
      rate_limits: { five_hour: { used_percentage: pct, resets_at: 1999999999 } },
    }) });
    try {
      await refresh(51);
      assert.ok(await waitFor(() => received.length === 1), "the first upload started");
      await Promise.all([52, 53, 54, 55].map(refresh));
      // The detached workers have time to see the held lock. They must
      // finish without waiting for the first HTTP response.
      await sleep(1000);
      await refresh(100);
      await sleep(500);
      assert.deepEqual(received, [51]);
      releaseFirst();
      await collectorsDone(marker);
      assert.deepEqual(received, [51, 100], "the final snapshot is sent even when refreshes stop");
      await refresh(100);
      await collectorsDone(marker);
      assert.deepEqual(received, [51, 100], "an unchanged final value stays cached");
    } finally {
      releaseFirst();
      cmd(srv.base);
      await new Promise((resolve) => endpoint.close(resolve));
    }
  });

  test("a redirect cannot forward the device bearer key", async () => {
    const before = await stats();
    const file = saved();
    fs.appendFileSync(transcript, entry("msg_redirect", 9) + "\n");
    let received = 0;
    const destination = http.createServer((request, response) => {
      if (request.url === "/api/ingest/claude-code" && request.headers.authorization === `Bearer ${key}`) received++;
      response.end("{}");
    });
    await new Promise((resolve) => destination.listen(0, "127.0.0.1", resolve));
    let redirectStatus = 302;
    const source = http.createServer((request, response) => {
      response.writeHead(redirectStatus, { Location: `http://127.0.0.1:${destination.address().port}/api/ingest/claude-code` });
      response.end();
    });
    await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve));
    try {
      for (redirectStatus of [301, 302, 303, 307, 308]) {
        await run(cmd(`http://127.0.0.1:${source.address().port}`), { env });
        await collectorsDone(marker);
        assert.equal(received, 0, `${redirectStatus} must not forward the key`);
        assert.equal(saved(), file, `${redirectStatus} must not advance offsets`);
      }
    } finally {
      await new Promise((resolve) => source.close(resolve));
      await new Promise((resolve) => destination.close(resolve));
    }
    await run(cmd(srv.base), { env });
    assert.ok(await waitFor(async () => (await stats()).events === before.events + 1), "the rejected message is retried");
    await collectorsDone(marker);
    assert.equal(offsets()[transcript], fs.statSync(transcript).size);
    assert.equal((await stats()).total_tokens - before.total_tokens, PER_MESSAGE + 9);
  });

  test("offsets are kept per server and key: a new one gets the whole history, an earlier one resumes", async () => {
    const local = new Set(fs.readdirSync(project, { recursive: true }).filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => [...fs.readFileSync(path.join(project, f), "utf8").matchAll(/"id":"(msg_\w+)"/g)].map((m) => m[1])));
    const rec = await recordingServer();
    const refresh = async (base, k) => {
      await run(cmd(base, k), { env });
      await collectorsDone(marker);
      return new Set(rec.take().map((m) => m.message_id));
    };
    try {
      assert.deepEqual(await refresh(rec.base), local, "a new server gets the whole history");
      assert.equal((await refresh(rec.base)).size, 0, "an unchanged target sends nothing again");
      assert.deepEqual(await refresh(rec.base, "ak_other"), local, "a new key gets the whole history");
      assert.equal((await refresh(rec.base)).size, 0, "switching back resumes where it was");
      assert.equal((await refresh(rec.base.replace("http", "HTTP") + "/")).size, 0, "the same URL, written differently");
      assert.ok(!saved().includes(key) && !saved().includes("ak_other"), "never the key");
      // Offsets from before targets belong to an unknown server: all is sent again.
      fs.writeFileSync(offsetsFile(), JSON.stringify(Object.fromEntries(
        fs.readdirSync(project, { recursive: true }).filter((f) => f.endsWith(".jsonl"))
          .map((f) => [path.join(project, f), fs.statSync(path.join(project, f)).size]))));
      assert.deepEqual(await refresh(rec.base), local, "the old shape is dropped");
      assert.deepEqual(Object.keys(JSON.parse(saved())), ["targets"]);
    } finally {
      cmd(srv.base);
      await rec.close();
    }
  });
});
