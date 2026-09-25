// Runs the OpenCode collector (collectors/opencode.py) through its plugin
// (collectors/opencode-plugin.js), installed as README.md says, against a
// real server, with a fake OpenCode database in a temporary HOME.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { startServer, req, newDevice, asNewClient } from "./helpers.js";

const SCRIPT = fs.readFileSync(new URL("../collectors/opencode.py", import.meta.url), "utf8");
const PLUGIN = fs.readFileSync(new URL("../collectors/opencode-plugin.js", import.meta.url), "utf8");

const START = Date.now() - 3600 * 1000;
let seq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}

describe("OpenCode collector (plugin from README.md)", () => {
  let srv, key, home, db, hooks;
  const summary = async () => (await req(srv.base, "GET", "/api/u/admin/summary?tool=opencode", { headers: asNewClient() })).json.total;
  const configDir = () => path.join(home, ".config", "opencode");
  const install = (server) => fs.writeFileSync(path.join(configDir(), "ai-activity-opencode.py"),
    SCRIPT.replace("<server>", server).replace("<device key>", key));
  const statePath = () => path.join(home, ".cache", "ai-activity", "opencode.json");
  const state = () => JSON.parse(fs.readFileSync(statePath(), "utf8"));
  const idle = () => hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } });

  function session(id, parent = null) {
    db.prepare("INSERT INTO session (id, parent_id, title, directory) VALUES (?, ?, 'secret title', '/secret/path')").run(id, parent);
  }
  /** One message as OpenCode 1.18 stores it: reasoning apart from output, counted in total. */
  function message(id, sessionId, tokens, { role = "assistant", completed = true, provider = "anthropic", model = "claude-sonnet-5" } = {}) {
    const t = START + 1000 * seq++;
    const total = tokens && tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
    const data = role === "user"
      ? { role, time: { created: t }, summary: { title: "secret prompt" } }
      : { role, providerID: provider, modelID: model, cost: 0.1, path: { cwd: "/secret/path" },
          time: completed ? { created: t - 500, completed: t } : { created: t - 500 },
          tokens: tokens ? { total, ...tokens } : undefined };
    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET time_updated = excluded.time_updated, data = excluded.data`)
      .run(id, sessionId, t - 500, Date.now(), JSON.stringify(data));
  }
  const tok = (input, output, reasoning = 0, read = 0, write = 0) => ({ input, output, reasoning, cache: { read, write } });

  before(async () => {
    srv = await startServer();
    key = (await newDevice(srv.base, "opencode-collector")).key;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-activity-opencode-"));
    // The plugin runs inside OpenCode and spawns the collector with its environment.
    Object.assign(process.env, { HOME: home, XDG_DATA_HOME: "", OPENCODE_DB: "", TZ: "IST-5:30" }); // POSIX TZ: UTC+5:30
    fs.mkdirSync(path.join(configDir(), "plugins"), { recursive: true });
    fs.mkdirSync(path.join(home, ".local", "share", "opencode"), { recursive: true });
    db = new Database(path.join(home, ".local", "share", "opencode", "opencode.db"));
    db.pragma("journal_mode = WAL"); // like OpenCode: the collector reads while it writes
    db.exec(`CREATE TABLE session (id text PRIMARY KEY, parent_id text, title text NOT NULL, directory text NOT NULL);
      CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
        time_updated integer NOT NULL, data text NOT NULL);
      CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, data text NOT NULL);`);
    session("ses_root");
    session("ses_sub", "ses_root");
    session("ses_subsub", "ses_sub");
    session("ses_other");
    message("msg_u1", "ses_root", null, { role: "user" });
    db.prepare("INSERT INTO part VALUES ('prt_1', 'msg_u1', 'ses_root', ?)").run(JSON.stringify({ type: "text", text: "secret prompt" }));
    message("msg_a1", "ses_root", tok(325, 1241, 10, 26353));
    message("msg_a2", "ses_sub", tok(100, 50, 0, 900, 20));
    message("msg_a3", "ses_subsub", tok(10, 5));
    message("msg_a4", "ses_other", tok(7, 3), { provider: "openai", model: "gpt-6-astra" });
    message("msg_empty", "ses_other", tok(0, 0));
    message("msg_errored", "ses_other", undefined);
  });
  after(() => {
    db.close();
    srv.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("the plugin sends every message once when OpenCode starts", async () => {
    install(srv.base);
    const plugin = path.join(configDir(), "plugins", "ai-activity.js");
    fs.writeFileSync(plugin, PLUGIN);
    hooks = await (await import(plugin)).AIActivity({});
    assert.ok(await waitFor(async () => (await summary()).events === 4), "4 messages stored");
    const t = await summary();
    assert.equal(t.tokens, 27929 + 1070 + 15 + 10);
    assert.deepEqual(t.by_model.map((x) => x.name).sort(), ["anthropic/claude-sonnet-5", "openai/gpt-6-astra"]);
    // Subagent sessions count as their root conversation.
    assert.equal(t.sessions, 2);
    const s = (await req(srv.base, "GET", "/api/u/admin/sessions?tool=opencode")).json.sessions;
    assert.deepEqual(s.map((x) => x.session_id).sort(), ["ses_other", "ses_root"]);
    assert.equal(s.find((x) => x.session_id === "ses_root").events, 3);
    const server = new Database(srv.dbPath, { readonly: true });
    const offsets = server.prepare("SELECT DISTINCT utc_offset_min AS o FROM usage_events").all().map((r) => r.o);
    server.close();
    assert.deepEqual(offsets, [330]);
  });

  test("an idle session sends only what changed, and final counts replace a partial message", async () => {
    await waitFor(() => fs.existsSync(statePath()));
    const before = await summary();
    message("msg_a5", "ses_root", tok(40, 2), { completed: false });
    await idle();
    assert.ok(await waitFor(async () => (await summary()).events === before.events + 1));
    assert.equal((await summary()).tokens - before.tokens, 42);
    message("msg_a5", "ses_root", tok(40, 60, 8));
    await idle();
    assert.ok(await waitFor(async () => (await summary()).tokens - before.tokens === 108));
    assert.equal((await summary()).events, before.events + 1);
  });

  test("nothing is lost while the server is down", async () => {
    await sleep(500);
    const before = await summary();
    const saved = state();
    message("msg_a6", "ses_other", tok(100, 5));
    install("http://127.0.0.1:9");
    await idle();
    await sleep(1500);
    assert.deepEqual(state(), saved);
    install(srv.base);
    // Idle twice at once: the plugin runs the collector again after, nothing is sent twice.
    await Promise.all([idle(), idle()]);
    assert.ok(await waitFor(async () => (await summary()).events === before.events + 1));
    await sleep(1000);
    assert.equal((await summary()).tokens - before.tokens, 105);
  });

  test("no prompt, reply, title or path is read", () => {
    const query = SCRIPT.match(/QUERY = """([\s\S]*?)"""/)[1];
    assert.ok(!/\bpart\b|summary|text|title|path|cwd/.test(query));
    assert.ok(!/SELECT[^"]*\b(title|directory)\b/.test(SCRIPT));
  });
});
