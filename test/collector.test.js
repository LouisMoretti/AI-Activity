// Runs the collector one-liners exactly as printed in README.md against a
// real server, with fake transcripts in a temporary HOME.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, req, newDevice } from "./helpers.js";

const README = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
const statusLine = JSON.parse(`{${README.match(/```json\n([\s\S]*?)\n```/)[1]}}`).statusLine.command;
const backfill = README.match(/```bash\n(python3 -c [\s\S]*?)\n```/)[1];

const entry = (id, output, { session = "sess-1", agent = null, at = "2026-09-20T10:00:00.123Z" } = {}) =>
  JSON.stringify({
    type: "assistant", sessionId: session, agentId: agent, timestamp: at,
    message: { id, model: "claude-opus-5-5", content: [{ type: "text", text: "secret reply" }],
      usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: output } },
  });

/** Run a shell command with stdin, in its own process group; optionally kill that group early. */
function run(cmd, { stdin = "", env, killAfterMs } = {}) {
  return new Promise((resolve) => {
    const p = spawn("sh", ["-c", cmd], { env, detached: true, stdio: ["pipe", "ignore", "ignore"] });
    p.stdin.end(stdin);
    if (killAfterMs !== undefined) setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch { /* exited */ } }, killAfterMs);
    p.on("exit", resolve);
  });
}

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("collector one-liners from README.md", () => {
  let srv, key, home, env, transcript;
  const stats = async () => (await req(srv.base, "GET", "/api/u/admin/stats?days=730")).json;
  const fill = (cmd) => cmd.replaceAll("<server>", srv.base).replaceAll("<device key>", key);

  before(async () => {
    srv = await startServer();
    key = (await newDevice(srv.base, "collector")).key;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-activity-home-"));
    env = { ...process.env, HOME: home, XDG_RUNTIME_DIR: home };
    const project = path.join(home, ".claude", "projects", "-work");
    fs.mkdirSync(path.join(project, "sess-1", "subagents"), { recursive: true });
    transcript = path.join(project, "sess-1.jsonl");
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: "user", message: { content: "secret prompt" } }),
      entry("msg_a", 3), // partial…
      entry("msg_a", 983), // …then final: counted once, with 983
      entry("msg_b", 10),
      "{not json",
      "",
    ].join("\n") + entry("msg_half_written", 1)); // no trailing newline: still being written
    fs.writeFileSync(path.join(project, "sess-1", "subagents", "agent-x.jsonl"),
      entry("msg_sub", 16, { agent: "x" }) + "\n");
  });
  after(() => srv.stop());

  const perMessage = 2 + 100 + 1000;
  const expected = 3 * perMessage + 983 + 10 + 16;

  test("statusLine: one row per message id, sent even when the group is killed", async () => {
    const before = await stats();
    const input = JSON.stringify({
      session_id: "sess-1", transcript_path: transcript,
      rate_limits: { five_hour: { used_percentage: 21, resets_at: 1999999999 } },
      context_window: { used_percentage: 37, context_window_size: 200000 },
    });
    // Claude Code cancels the command on the next refresh: kill its whole group.
    await run(fill(statusLine), { stdin: input, env, killAfterMs: 150 });
    const got = await waitFor(async () => (await stats()).events - before.events === 3);
    assert.ok(got, "the detached upload finished despite the kill");
    const after = await stats();
    assert.equal(after.total_tokens - before.total_tokens, expected);

    // Every refresh resends the recent messages: totals never move.
    for (let i = 0; i < 3; i++) await run(fill(statusLine), { stdin: input, env });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await stats()).total_tokens, after.total_tokens);

    const quotas = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas;
    assert.ok(quotas.some((q) => q.limit_type === "five_hour" && q.used_pct === 21));
    const s = (await req(srv.base, "GET", "/api/u/admin/sessions")).json.sessions.find((x) => x.session_id === "sess-1");
    assert.equal(s.context_used_pct, 37);
  });

  test("backfill sends every transcript once and is safe to rerun", async () => {
    const before = await stats();
    fs.appendFileSync(transcript, "\n" + entry("msg_old", 5) + "\n");
    for (let i = 0; i < 2; i++) assert.equal(await run(fill(backfill), { env }), 0);
    const after = await stats();
    // msg_half_written is now a complete line too.
    assert.equal(after.total_tokens - before.total_tokens, 2 * perMessage + 5 + 1);
    assert.equal(after.events - before.events, 2);
  });
});
