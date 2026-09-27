// Runs the one-command install as a device would, in a temporary home,
// against a real server: /install.sh piped to sh (Linux/macOS), or
// /install.ps1 through `irm … | iex` in PowerShell (Windows). Merges into
// existing configs, is idempotent, and the installed commands upload.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, newDevice, req, asNewClient, running, tempHome } from "./helpers.js";

const WINDOWS = process.platform === "win32";
const README = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const between = (from, to) => README.split(from)[1].split(to)[0];
const jsonBlocks = (text) => [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
// The README's Linux/macOS commands: what the installer writes there.
const STATUS_LINE = JSON.parse(`{${jsonBlocks(between("## Send Claude Code usage", "## Send Codex"))[0]}}`).statusLine;
const CODEX_HOOKS = JSON.parse(jsonBlocks(between("## Send Codex usage", "## Send Antigravity"))[0]).hooks;
const ANTIGRAVITY_HOOK = JSON.parse(jsonBlocks(between("## Send Antigravity usage", "## Send OpenCode"))[0])["ai-activity"];
const source = (f) => fs.readFileSync(new URL(`../collectors/${f}`, import.meta.url), "utf8");
const PLUGIN = source("opencode-plugin.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(200);
  }
}

describe(`one-command install (${WINDOWS ? "/install.ps1" : "/install.sh"})`, () => {
  let srv, key, home, script, env;
  const file = (...p) => path.join(home, ...p);
  const read = (...p) => fs.readFileSync(file(...p), "utf8");
  const json = (...p) => JSON.parse(read(...p));
  const filled = (f, k = key) => source(f).replace('"<server>"', JSON.stringify(srv.base)).replace('"<device key>"', JSON.stringify(k));
  // On Windows, the absolute interpreter, then the script, both quoted.
  const windowsCommand = (p, ...args) => new RegExp(`^"[^"]+" ${JSON.stringify(p).replaceAll("\\", "\\\\")}${args.map((a) => " " + a).join("")}$`);

  function install(extra = {}) {
    return new Promise((resolve) => {
      const p = WINDOWS
        ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `irm ${srv.base}/install.ps1 | iex`],
          { env: { ...env, ...extra }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
        : spawn(path.join(env.PATH, "sh"), [], { env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.stderr.on("data", (c) => (out += c));
      if (!WINDOWS) p.stdin.end(script);
      p.on("exit", (code) => resolve({ code, out }));
    });
  }

  before(async () => {
    srv = await startServer();
    key = (await newDevice(srv.base, "installer")).key;
    home = tempHome("ai-activity-install-");
    const { AI_ACTIVITY_URL, AI_ACTIVITY_KEY, AI_ACTIVITY_TOOLS, CODEX_HOME, GEMINI_CLI_HOME, XDG_CONFIG_HOME, ...inherited } = process.env;
    if (WINDOWS) {
      // PowerShell and Python need the real PATH; the runner has none of the tools.
      env = { ...inherited, HOME: home, USERPROFILE: home };
    } else {
      // PATH with only what the script needs, not the real tools: presence
      // comes from the config folders.
      const bin = path.join(home, "bin");
      fs.mkdirSync(bin);
      for (const cmd of ["sh", "python3", "setsid"]) {
        const found = (process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, cmd)).find((f) => fs.existsSync(f));
        if (found) fs.symlinkSync(found, path.join(bin, cmd));
      }
      env = { PATH: bin, HOME: home };
    }
    Object.assign(env, { AI_ACTIVITY_URL: srv.base + "/", AI_ACTIVITY_KEY: key });
    for (const p of ["/install.sh", "/install.ps1"]) {
      const r = await fetch(srv.base + p);
      assert.equal(r.status, 200);
      const text = await r.text();
      assert.ok(!text.includes(key), "the script never carries a key");
      if (p === "/install.sh") script = text;
      else assert.match(text, /^[\x00-\x7f]*$/, "PowerShell reads it whatever the code page");
    }
  });
  after(async () => {
    await waitFor(() => !running(file(".claude")));
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
    fs.mkdirSync(file(".claude", "projects", "-work"), { recursive: true });
    fs.writeFileSync(file(".claude", "settings.json"), JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"] } }));
    fs.mkdirSync(file(".codex"), { recursive: true });
    const other = { hooks: [{ type: "command", command: "notify-send done" }] };
    fs.writeFileSync(file(".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [other] } }));
    fs.mkdirSync(file(".gemini", "antigravity", "conversations"), { recursive: true });
    const theirs = { enabled: true, Stop: [{ type: "command", command: "echo hi" }] };
    fs.mkdirSync(file(".gemini", "config"));
    fs.writeFileSync(file(".gemini", "config", "hooks.json"), JSON.stringify({ theirs }));
    // No ~/.config/opencode: OpenCode is not installed here.

    const r = await install();
    assert.equal(r.code, 0, r.out);

    const settings = json(".claude", "settings.json");
    assert.equal(settings.model, "opus");
    assert.deepEqual(settings.permissions, { allow: ["Bash(ls)"] });
    assert.equal(read(".claude", "ai-activity-claude-code.py"), filled("claude-code.py"));
    if (WINDOWS) assert.match(settings.statusLine.command, windowsCommand(file(".claude", "ai-activity-claude-code.py")));
    else assert.deepEqual(settings.statusLine, STATUS_LINE);

    assert.equal(read(".codex", "ai-activity-codex.py"), filled("codex.py"));
    const hooks = json(".codex", "hooks.json").hooks;
    assert.deepEqual(hooks.Stop[0], other);
    for (const event of ["Stop", "UserPromptSubmit", "PostToolUse"]) {
      const ours = hooks[event].filter((h) => JSON.stringify(h).includes("ai-activity-codex.py"));
      assert.equal(ours.length, 1);
      if (WINDOWS) assert.match(ours[0].hooks[0].command, windowsCommand(file(".codex", "ai-activity-codex.py"), "--hook"));
      else if (fs.existsSync(path.join(env.PATH, "setsid"))) assert.deepEqual(ours[0], CODEX_HOOKS[event][0]);
      else assert.equal(ours[0].hooks[0].command, "python3 ~/.codex/ai-activity-codex.py --hook");
    }

    assert.equal(read(".gemini", "ai-activity-antigravity.py"), filled("antigravity.py"));
    const gemini = json(".gemini", "config", "hooks.json");
    assert.deepEqual(gemini.theirs, theirs);
    if (WINDOWS) {
      const p = file(".gemini", "ai-activity-antigravity.py");
      assert.match(gemini["ai-activity"].PostInvocation[0].command, windowsCommand(p, "--post-invocation"));
      assert.match(gemini["ai-activity"].Stop[0].command, windowsCommand(p, "--hook"));
    } else assert.deepEqual(gemini["ai-activity"], ANTIGRAVITY_HOOK);

    if (!WINDOWS) {
      for (const p of [[".claude", "ai-activity-claude-code.py"], [".codex", "ai-activity-codex.py"], [".gemini", "ai-activity-antigravity.py"]]) {
        assert.equal(fs.statSync(file(...p)).mode & 0o777, 0o600, "the key is readable by its owner only");
      }
    }
    assert.ok(!fs.existsSync(file(".config", "opencode")));
  });

  test("the installed statusLine uploads with that URL and key", async () => {
    fs.writeFileSync(file(".claude", "projects", "-work", "s1.jsonl"), JSON.stringify({
      type: "assistant", sessionId: "s1", timestamp: new Date().toISOString(),
      message: { id: "msg_install_1", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 41 } },
    }) + "\n");
    const { statusLine } = json(".claude", "settings.json");
    // Run like Claude Code does: through a shell, the status line JSON on stdin.
    await new Promise((resolve) => {
      const p = WINDOWS
        ? spawn(statusLine.command, { env, shell: true, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] })
        : spawn("sh", ["-c", statusLine.command], { env, stdio: ["pipe", "ignore", "ignore"] });
      p.stdin.on("error", () => {});
      p.stdin.end("{}");
      p.on("exit", resolve);
    });
    const tokens = async () => (await req(srv.base, "GET", "/api/u/admin/stats?days=30", { headers: asNewClient() })).json.total_tokens;
    assert.equal(await waitFor(async () => (await tokens()) === 42), true, "the upload reached the server");
  });

  test("running it again changes nothing", async () => {
    await waitFor(() => !running(file(".claude")));
    const paths = [[".claude", "settings.json"], [".claude", "ai-activity-claude-code.py"], [".codex", "hooks.json"],
      [".codex", "ai-activity-codex.py"], [".gemini", "config", "hooks.json"], [".gemini", "ai-activity-antigravity.py"]];
    const snap = () => Object.fromEntries(paths.map((p) => [p.join("/"), [read(...p), fs.statSync(file(...p)).mtimeMs]]));
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
    assert.equal(read(".codex", "ai-activity-codex.py"), filled("codex.py", key2));
    assert.equal(read(".claude", "ai-activity-claude-code.py"), filled("claude-code.py", key2));
    assert.equal(read(".gemini", "ai-activity-antigravity.py"), filled("antigravity.py", key2));
    assert.ok(!read(".claude", "settings.json").includes(key2), "the key is in the script, not the settings");
    assert.equal(json(".codex", "hooks.json").hooks.UserPromptSubmit.length, 1);
    assert.equal(json(".codex", "hooks.json").hooks.Stop.length, 2);
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
    assert.ok(json(".claude", "settings.json").statusLine.command.includes("ai-activity-claude-code.py"));
  });

  test("AI_ACTIVITY_TOOLS installs a tool not found yet", async () => {
    const r = await install({ AI_ACTIVITY_TOOLS: "opencode" });
    assert.equal(r.code, 0, r.out);
    assert.equal(read(".config", "opencode", "plugins", "ai-activity.js"), PLUGIN);
    assert.equal(read(".config", "opencode", "ai-activity-opencode.py"), filled("opencode.py"));
    assert.notEqual((await install({ AI_ACTIVITY_TOOLS: "cursor" })).code, 0);
  });
});
