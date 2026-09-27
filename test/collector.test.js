// Runs the Claude Code collector exactly as printed in README.md against a
// real server, with fake transcripts in a temporary HOME: the statusLine
// one-liner (not on Windows: it needs setsid), and collectors/claude-code.py
// through the Windows statusLine command.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { startServer, req, newDevice, asNewClient, running, PYTHON, tempHome } from "./helpers.js";

const WINDOWS = process.platform === "win32";
const README = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const section = README.split("## Send Claude Code usage from a device")[1].split("## Send Codex")[0];
const [statusLine, windowsStatusLine] = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)]
  .map((m) => JSON.parse(`{${m[1]}}`).statusLine.command);
const SCRIPT = fs.readFileSync(new URL("../collectors/claude-code.py", import.meta.url), "utf8");
// The README's Windows command names C:\Users\<user>: run it on this test's copy instead.
const WINDOWS_PREFIX = 'python "C:\\Users\\<user>\\.claude\\ai-activity-claude-code.py"';

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
 * that group early. On Windows: through cmd.exe, killing its process tree.
 */
function run(cmd, { stdin = "{}", env, killAfterMs } = {}) {
  return new Promise((resolve) => {
    const p = WINDOWS
      ? spawn(cmd, { env, shell: true, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] })
      : spawn("sh", ["-c", cmd], { env, detached: true, stdio: ["pipe", "ignore", "ignore"] });
    p.stdin.on("error", () => {}); // killed before reading its input (EPIPE)
    p.stdin.end(stdin);
    const kill = () => {
      try {
        if (WINDOWS) execFileSync("taskkill", ["/T", "/F", "/PID", String(p.pid)], { stdio: "ignore" });
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
 * #123). `marker` is on its command line: the device key for the one-liner,
 * the script path for the script.
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

const VARIANTS = [
  ...(WINDOWS ? [] : [{ name: "statusLine one-liner", script: false }]),
  { name: "statusLine script (collectors/claude-code.py)", script: true },
];

for (const variant of VARIANTS) describe(`Claude Code collector: ${variant.name} from README.md`, () => {
  let srv, key, home, env, proxy, project, transcript, marker;
  const stats = async () => (await req(srv.base, "GET", "/api/u/admin/stats?days=730", { headers: asNewClient() })).json;
  const scriptPath = () => path.join(home, ".claude", "ai-activity-claude-code.py");
  /** The statusLine command posting to `base`; the script variant installs its copy for that. */
  const cmd = (base) => {
    if (!variant.script) return statusLine.replaceAll("<server>", base).replaceAll("<device key>", key);
    fs.writeFileSync(scriptPath(), SCRIPT.replace("<server>", base).replace("<device key>", key));
    if (!WINDOWS) return `'${PYTHON}' '${scriptPath()}'`;
    assert.ok(windowsStatusLine.startsWith(WINDOWS_PREFIX));
    return windowsStatusLine.replace(WINDOWS_PREFIX, `"${PYTHON}" "${scriptPath()}"`);
  };
  const viaProxy = () => cmd(`http://127.0.0.1:${proxy.address().port}`);
  const offsets = () => JSON.parse(fs.readFileSync(path.join(home, ".cache", "ai-activity", "offsets.json"), "utf8"));

  before(async () => {
    srv = await startServer();
    key = (await newDevice(srv.base, "collector")).key;
    proxy = await slowProxy(srv.base, 1500);
    home = tempHome("ai-activity-home-");
    marker = variant.script ? scriptPath() : key;
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

  test("first refresh sends every message once, even when its process group is killed mid-upload", async () => {
    const input = JSON.stringify({
      session_id: "sess-1", transcript_path: transcript,
      rate_limits: { five_hour: { used_percentage: 21, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
      context_window: { used_percentage: 37, context_window_size: 200000 },
    });
    // Claude Code cancels the command on the next refresh. The proxy holds the
    // upload for 1.5 s, so without detaching the kill always lands mid-upload
    // (Windows starts Python slower: later there, still mid-upload).
    await run(viaProxy(), { stdin: input, env, killAfterMs: WINDOWS ? 1000 : 300 });
    assert.ok(await waitFor(async () => (await stats()).events === 5), "the detached upload finished despite the kill");
    assert.equal((await stats()).total_tokens, 5 * PER_MESSAGE + 983 + 10 + 20 + 30 + 16);
    const q = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas;
    assert.ok(q.some((x) => x.limit_type === "five_hour" && x.used_pct === 21));
    const s = (await req(srv.base, "GET", "/api/u/admin/sessions")).json.sessions.find((x) => x.session_id === "sess-1");
    assert.equal(s.context_used_pct, 37);
    // Each entry carries the device's UTC offset at that time, in minutes.
    const db = new Database(srv.dbPath, { readonly: true });
    const utcOffsets = db.prepare("SELECT DISTINCT utc_offset_min AS o FROM usage_events").all().map((r) => r.o);
    db.close();
    assert.deepEqual(utcOffsets, [330]);
    // Offsets stop before the half-written line. They are saved after the
    // server answered, so the events can show up first.
    await collectorsDone(marker);
    assert.equal(offsets()[transcript], fs.readFileSync(transcript).lastIndexOf(10) + 1);
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
    const saved = offsets();
    fs.appendFileSync(transcript, entry("msg_offline", 7) + "\n");
    await run(cmd("http://127.0.0.1:9"), { env });
    // The failed run saves nothing: wait until it is gone, then the
    // unchanged offsets mean something.
    await collectorsDone(marker);
    assert.deepEqual(offsets(), saved);
    // Two refreshes at once: the second waits for the lock, nothing is sent twice.
    await Promise.all([run(cmd(srv.base), { env }), run(cmd(srv.base), { env })]);
    assert.ok(await waitFor(async () => (await stats()).events === before.events + 1));
    // The events show up before the detached uploads saved their offsets.
    await collectorsDone(marker);
    assert.equal((await stats()).total_tokens - before.total_tokens, PER_MESSAGE + 7);
  });

  test("a refresh with no new messages still posts quotas", async () => {
    // Every refresh carries the status line's rate_limits, even with nothing
    // new in the transcripts: an exhausted quota records its final value.
    const before = await stats();
    const input = JSON.stringify({
      session_id: "sess-1",
      rate_limits: { five_hour: { used_percentage: 100, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
    });
    await run(cmd(srv.base), { stdin: input, env });
    assert.ok(await waitFor(async () =>
      (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas
        .some((x) => x.limit_type === "five_hour" && x.used_pct === 100)));
    assert.equal((await stats()).total_tokens, before.total_tokens, "no usage stored from a quota-only refresh");
  });
});
