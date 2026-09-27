// Runs /install.sh as a device would (curl … | sh), in a temporary HOME,
// against a real server: merges into existing configs, idempotent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, newDevice } from "./helpers.js";

const README = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
const statusLine = JSON.parse(`{${README.match(/```json\n([\s\S]*?)\n```/)[1]}}`).statusLine.command;
const CODEX = fs.readFileSync(new URL("../collectors/codex.py", import.meta.url), "utf8");
const PLUGIN = fs.readFileSync(new URL("../collectors/opencode-plugin.js", import.meta.url), "utf8");

function sh(script, env) {
  return new Promise((resolve) => {
    const p = spawn(path.join(env.PATH, "sh"), [], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.stdin.end(script);
    p.on("exit", (code) => resolve({ code, out }));
  });
}

describe("one-command install (/install.sh)", () => {
  let srv, key, home, script, env;
  const file = (...p) => path.join(home, ...p);
  const read = (...p) => fs.readFileSync(file(...p), "utf8");
  const json = (...p) => JSON.parse(read(...p));
  const install = (extra = {}) => sh(script, { ...env, ...extra });

  before(async () => {
    srv = await startServer();
    key = (await newDevice(srv.base, "installer")).key;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-activity-install-"));
    // PATH with only what the script needs, not the real tools: presence
    // comes from the config folders.
    const bin = path.join(home, "bin");
    fs.mkdirSync(bin);
    for (const cmd of ["sh", "python3", "setsid"]) {
      const found = (process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, cmd)).find((f) => fs.existsSync(f));
      if (found) fs.symlinkSync(found, path.join(bin, cmd));
    }
    env = { PATH: bin, HOME: home, AI_ACTIVITY_URL: srv.base + "/", AI_ACTIVITY_KEY: key };
    const r = await fetch(srv.base + "/install.sh");
    assert.equal(r.status, 200);
    script = await r.text();
    assert.ok(!script.includes(key), "the script never carries a key");
  });
  after(() => {
    srv.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("needs a server URL and a device key, and a known one", async () => {
    assert.notEqual((await install({ AI_ACTIVITY_KEY: "" })).code, 0);
    assert.notEqual((await install({ AI_ACTIVITY_URL: "not a url" })).code, 0);
    const bad = await install({ AI_ACTIVITY_KEY: "ak_" + "0".repeat(32), AI_ACTIVITY_TOOLS: "codex" });
    assert.notEqual(bad.code, 0);
    assert.match(bad.out, /refused this device key/);
    assert.ok(!fs.existsSync(file(".codex")), "nothing installed with a refused key");
  });

  test("installs the tools found, keeping existing settings and hooks", async () => {
    fs.mkdirSync(file(".claude"), { recursive: true });
    fs.writeFileSync(file(".claude", "settings.json"), JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"] } }));
    fs.mkdirSync(file(".codex"), { recursive: true });
    const other = { hooks: [{ type: "command", command: "notify-send done" }] };
    fs.writeFileSync(file(".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [other] } }));
    // No ~/.config/opencode: OpenCode is not installed here.

    const r = await install();
    assert.equal(r.code, 0, r.out);
    const settings = json(".claude", "settings.json");
    assert.equal(settings.model, "opus");
    assert.deepEqual(settings.permissions, { allow: ["Bash(ls)"] });
    assert.equal(settings.statusLine.command,
      statusLine.replaceAll("<server>", srv.base).replaceAll("<device key>", key));

    assert.equal(read(".codex", "ai-activity-codex.py"),
      CODEX.replace("<server>", srv.base).replace("<device key>", key));
    assert.equal(fs.statSync(file(".codex", "ai-activity-codex.py")).mode & 0o777, 0o600);
    const hooks = json(".codex", "hooks.json").hooks;
    assert.deepEqual(hooks.Stop[0], other);
    for (const event of ["Stop", "UserPromptSubmit"]) {
      const ours = hooks[event].filter((h) => JSON.stringify(h).includes("ai-activity-codex.py"));
      assert.equal(ours.length, 1);
      assert.match(ours[0].hooks[0].command, /^setsid -f python3 ~\/\.codex\/ai-activity-codex\.py /);
    }
    assert.ok(!fs.existsSync(file(".config", "opencode")));
  });

  test("running it again changes nothing", async () => {
    const snap = () => Object.fromEntries([
      [".claude", "settings.json"], [".codex", "hooks.json"], [".codex", "ai-activity-codex.py"],
    ].map((p) => [p.join("/"), [read(...p), fs.statSync(file(...p)).mtimeMs]]));
    const before = snap();
    const r = await install();
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(snap(), before);
    assert.match(r.out, /already up to date/);
  });

  test("a new key replaces the old one without duplicating hooks", async () => {
    const key2 = (await newDevice(srv.base, "installer-2")).key;
    const r = await install({ AI_ACTIVITY_KEY: key2 });
    assert.equal(r.code, 0, r.out);
    assert.ok(read(".codex", "ai-activity-codex.py").includes(key2));
    assert.ok(json(".claude", "settings.json").statusLine.command.includes(key2));
    assert.equal(json(".codex", "hooks.json").hooks.UserPromptSubmit.length, 1);
    await install(); // back to the first key for the next tests
  });

  test("never replaces another statusLine unless asked", async () => {
    const mine = { type: "command", command: "echo my status" };
    const settings = json(".claude", "settings.json");
    fs.writeFileSync(file(".claude", "settings.json"), JSON.stringify({ ...settings, statusLine: mine }));
    const r = await install({ AI_ACTIVITY_TOOLS: "claude-code" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /already has another statusLine/);
    assert.deepEqual(json(".claude", "settings.json").statusLine, mine);
    await install({ AI_ACTIVITY_TOOLS: "claude-code", AI_ACTIVITY_FORCE: "1" });
    assert.ok(json(".claude", "settings.json").statusLine.command.includes("/api/ingest/claude-code"));
  });

  test("AI_ACTIVITY_TOOLS installs a tool not found yet", async () => {
    const r = await install({ AI_ACTIVITY_TOOLS: "opencode" });
    assert.equal(r.code, 0, r.out);
    assert.equal(read(".config", "opencode", "plugins", "ai-activity.js"), PLUGIN);
    assert.ok(read(".config", "opencode", "ai-activity-opencode.py").includes(key));
    assert.notEqual((await install({ AI_ACTIVITY_TOOLS: "cursor" })).code, 0);
  });
});
