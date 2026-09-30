// Runs the one-command install as a device would, in a temporary home,
// against a real server: /install.sh piped to sh (Linux/macOS), or
// /install.ps1 through `irm … | iex` in PowerShell (Windows). Merges into
// existing configs, is idempotent, and the installed commands upload.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, newDevice, req, asNewClient, running, tempHome, PYTHON } from "./helpers.js";

const WINDOWS = process.platform === "win32";
const README = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const between = (from, to) => README.split(from)[1].split(to)[0];
const jsonBlocks = (text) => [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
// The README's Linux/macOS commands: what the installer writes there.
const { hooks: CLAUDE_HOOKS, statusLine: STATUS_LINE } = JSON.parse(`{${jsonBlocks(between("## Send Claude Code usage", "## Send Codex"))[0]}}`);
const CLAUDE_EVENTS = ["UserPromptSubmit", "PostToolUse", "Stop", "StopFailure", "SessionEnd"];
const CODEX_HOOKS = JSON.parse(jsonBlocks(between("## Send Codex usage", "## Send Antigravity"))[0]).hooks;
const ANTIGRAVITY_HOOK = JSON.parse(jsonBlocks(between("## Send Antigravity usage", "## Send OpenCode"))[0])["ai-activity"];
const source = (f) => fs.readFileSync(new URL(`../collectors/${f}`, import.meta.url), "utf8");
const PLUGIN = source("opencode-plugin.js");

test("Windows Claude hooks use direct arguments and upgrade shell-form handlers", async () => {
  const home = tempHome("ai-activity Claude spaced-path-");
  try {
    const program = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("installer", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.WINDOWS = True
m.sys.executable = r"C:\\Program Files\\Python312\\python.exe"
m.CLAUDE_DIR = os.path.join(sys.argv[2], ".claude")
m.CONFIGS["claude-code"] = os.path.join(m.CLAUDE_DIR, "settings.json")
m.FILES["claude-code.py"] = 'SERVER = "<server>"; KEY = "<device key>"'
other = {"type": "command", "command": "echo preserved"}
old = {"type": "command", "command": 'python "C:/old/ai-activity-claude-code.py" --hook'}
m.write(m.CONFIGS["claude-code"], m.dump({"hooks": {event: [{"hooks": [old, other]}] for event in m.CLAUDE_HOOKS}}))
m.install_claude("https://example.com", "test-key")
first = open(m.CONFIGS["claude-code"], encoding="utf-8").read()
settings = json.loads(first)
script = os.path.join(m.CLAUDE_DIR, "ai-activity-claude-code.py")
for event in m.CLAUDE_HOOKS:
    entries = settings["hooks"][event]
    assert entries[0] == {"hooks": [other]}
    assert entries[1]["hooks"][0] == {"type": "command", "command": m.sys.executable, "args": [script, "--hook"], "timeout": 10}
wrapper = os.path.join(m.CLAUDE_DIR, "ai-activity-claude-code.ps1")
assert open(wrapper, encoding="utf-8-sig").read() == "& '" + m.sys.executable + "' '" + script.replace("'", "''") + "'\\n"
assert settings["statusLine"]["command"].endswith(' -File "' + wrapper.replace("\\\\", "/") + '"')
m.install_claude("https://example.com", "test-key")
assert open(m.CONFIGS["claude-code"], encoding="utf-8").read() == first
`;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(PYTHON, ["-c", program, fileURLToPath(new URL("../collectors/install.py", import.meta.url)), home]);
      let output = "";
      child.stdout.on("data", (part) => { output += part; });
      child.stderr.on("data", (part) => { output += part; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("installer generates and upgrades all Windows Codex hooks with quoted paths", async () => {
  const home = tempHome("ai-activity install-");
  try {
    const result = await new Promise((resolve, reject) => {
      const program = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("installer", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.WINDOWS = True
m.sys.executable = r"C:\\Program Files\\Python312\\python.exe"
m.CODEX_HOME = os.path.join(sys.argv[2], ".codex")
m.CONFIGS["codex"] = os.path.join(m.CODEX_HOME, "hooks.json")
m.FILES["codex.py"] = 'SERVER = "<server>"; KEY = "<device key>"'
script = os.path.join(m.CODEX_HOME, "ai-activity-codex.py")
old = m.command(script, "~/.codex/ai-activity-codex.py", "--hook")
other = {"hooks": [{"type": "command", "command": "echo preserved"}]}
events = ("UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd")
m.write(m.CONFIGS["codex"], m.dump({"hooks": {event: [other, {"hooks": [{"type": "command", "command": old}]}] for event in events}}))
m.install_codex("https://example.com", "test-key")
first = open(m.CONFIGS["codex"], encoding="utf-8").read()
config = json.loads(first)
for event in events:
    entries = config["hooks"][event]
    assert len(entries) == 2 and entries[0] == other
    assert entries[1]["hooks"][0]["command"] == r'& "C:\\Program Files\\Python312\\python.exe" "' + script + '" --hook'
    assert entries[1]["hooks"][0]["timeout"] == (3 if event == "SessionEnd" else 10)
m.install_codex("https://example.com", "test-key")
assert open(m.CONFIGS["codex"], encoding="utf-8").read() == first
# Claude Code / other shells keep their original invocation.
assert not m.command(script, "~/.codex/ai-activity-codex.py", "--hook").startswith("& ")
`;
      const child = spawn(PYTHON, ["-c", program,
        fileURLToPath(new URL("../collectors/install.py", import.meta.url)), home],
        { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { output += data; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installer writes quoteless Antigravity hook commands on Windows", async () => {
  // agy's hook runner splits the command naively on spaces and keeps the
  // quotes in the tokens, so a quoted path never resolves there (Windows
  // smoke, install.py short_path). Even a spaced interpreter must stay
  // quoteless; 8.3 short paths remove the spaces on a real Windows host.
  const home = tempHome("ai-activity install-agy-");
  try {
    const result = await new Promise((resolve, reject) => {
      const program = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("installer", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.WINDOWS = True
m.sys.executable = sys.executable
m.GEMINI_HOME = os.path.join(sys.argv[2], ".gemini")
m.CONFIGS["antigravity"] = os.path.join(m.GEMINI_HOME, "config", "hooks.json")
m.FILES["antigravity.py"] = 'SERVER = "<server>"; KEY = "<device key>"'
m.install_antigravity("https://example.com", "test-key")
config = json.load(open(m.CONFIGS["antigravity"], encoding="utf-8"))
script = os.path.join(m.GEMINI_HOME, "ai-activity-antigravity.py")
for event, flag in (("PostInvocation", "--post-invocation"), ("Stop", "--hook")):
    cmd = config["ai-activity"][event][0]["command"]
    assert '"' not in cmd, cmd
    assert cmd.endswith(" " + flag), cmd
    if os.name == "nt":
        # Real 8.3 short paths: no token holds a space, and the short script
        # resolves back to the installed one.
        import ctypes
        exe, installed, got_flag = cmd.split(" ")
        assert got_flag == flag and exe.lower().endswith("python.exe"), cmd
        buf = ctypes.create_unicode_buffer(300)
        assert ctypes.windll.kernel32.GetLongPathNameW(installed, buf, 300)
        assert os.path.normcase(buf.value) == os.path.normcase(script), cmd
    else:
        # short_path is a no-op off Windows: the long script stays as is.
        assert script in cmd, cmd
m.install_antigravity("https://example.com", "test-key")
print("quoteless antigravity hooks ok")
`;
      const child = spawn(PYTHON, ["-c", program,
        fileURLToPath(new URL("../collectors/install.py", import.meta.url)), home],
        { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { output += data; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

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
  const escape = (t) => t.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  const windowsCommand = (p, ...args) => new RegExp(`^"[^"]+" "${escape(p)}"${args.map((a) => " " + a).join("")}$`);

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
    home = tempHome("ai-activity install-");
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
    const theirHook = { matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] };
    fs.writeFileSync(file(".claude", "settings.json"), JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"] },
      hooks: { PostToolUse: [theirHook] } }));
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
    if (WINDOWS) {
      assert.equal(settings.statusLine.command, `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${file(".claude", "ai-activity-claude-code.ps1").replaceAll("\\", "/")}"`);
      assert.ok(read(".claude", "ai-activity-claude-code.ps1").includes("& '"));
    }
    else assert.deepEqual(settings.statusLine, STATUS_LINE);
    assert.deepEqual(Object.keys(CLAUDE_HOOKS), CLAUDE_EVENTS);
    assert.deepEqual(settings.hooks.PostToolUse[0], theirHook);
    for (const event of CLAUDE_EVENTS) {
      const ours = settings.hooks[event].filter((h) => JSON.stringify(h).includes("ai-activity-claude-code.py"));
      assert.equal(ours.length, 1);
      if (WINDOWS) {
        assert.ok(path.isAbsolute(ours[0].hooks[0].command));
        assert.ok(!ours[0].hooks[0].command.includes('"'));
        assert.deepEqual(ours[0].hooks[0].args, [file(".claude", "ai-activity-claude-code.py"), "--hook"]);
      }
      else assert.deepEqual(ours[0], CLAUDE_HOOKS[event][0]);
    }

    assert.equal(read(".codex", "ai-activity-codex.py"), filled("codex.py"));
    const hooks = json(".codex", "hooks.json").hooks;
    assert.deepEqual(hooks.Stop[0], other);
    for (const event of ["UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]) {
      const ours = hooks[event].filter((h) => JSON.stringify(h).includes("ai-activity-codex.py"));
      assert.equal(ours.length, 1);
      assert.equal(ours[0].hooks[0].timeout, event === "SessionEnd" ? 3 : 10);
      if (WINDOWS) assert.match(ours[0].hooks[0].command, new RegExp("^& " + windowsCommand(file(".codex", "ai-activity-codex.py"), "--hook").source.slice(1)));
      else if (fs.existsSync(path.join(env.PATH, "setsid"))) assert.deepEqual(ours[0], CODEX_HOOKS[event][0]);
      else assert.equal(ours[0].hooks[0].command, "python3 ~/.codex/ai-activity-codex.py --hook");
    }

    assert.equal(read(".gemini", "ai-activity-antigravity.py"), filled("antigravity.py"));
    const gemini = json(".gemini", "config", "hooks.json");
    assert.deepEqual(gemini.theirs, theirs);
    if (WINDOWS) {
      // Quoteless short paths: agy's hook runner splits naively on spaces,
      // so a quoted path never resolves (see short_path in install.py).
      for (const [event, flag] of [["PostInvocation", "--post-invocation"], ["Stop", "--hook"]]) {
        const cmd = gemini["ai-activity"][event][0].command;
        assert.ok(!cmd.includes('"'), `no quotes for agy's splitter: ${cmd}`);
        assert.match(cmd, new RegExp(`\\.py ${flag}$`, "i"));
      }
    } else assert.deepEqual(gemini["ai-activity"], ANTIGRAVITY_HOOK);

    if (!WINDOWS) {
      for (const p of [[".claude", "ai-activity-claude-code.py"], [".codex", "ai-activity-codex.py"], [".gemini", "ai-activity-antigravity.py"]]) {
        assert.equal(fs.statSync(file(...p)).mode & 0o777, 0o600, "the key is readable by its owner only");
      }
    }
    assert.ok(!fs.existsSync(file(".config", "opencode")));
  });

  // Run like Claude Code does: through a shell, its JSON on stdin.
  const runCommand = (command, stdin, shell = "cmd") => new Promise((resolve) => {
    const p = typeof command === "object" && command.args
      ? spawn(command.command, command.args, { env, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] })
      : WINDOWS && shell === "powershell"
      ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { env, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] })
      : WINDOWS
      ? spawn(command, { env, shell: true, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] })
      : spawn("sh", ["-c", command], { env, stdio: ["pipe", "ignore", "ignore"] });
    p.stdin.on("error", () => {});
    p.stdin.end(stdin);
    p.on("exit", resolve);
  });

  test("the installed hook uploads the tokens with that URL and key", async () => {
    fs.writeFileSync(file(".claude", "projects", "-work", "s1.jsonl"), JSON.stringify({
      type: "assistant", sessionId: "s1", timestamp: new Date().toISOString(),
      message: { id: "msg_install_1", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 41 } },
    }) + "\n");
    const { hooks } = json(".claude", "settings.json");
    const ours = hooks.Stop.find((h) => JSON.stringify(h).includes("ai-activity-claude-code.py"));
    const handler = ours.hooks[0];
    assert.equal(await runCommand(handler.args ? handler : handler.command, JSON.stringify({ hook_event_name: "Stop", session_id: "s1" })), 0);
    const tokens = async () => (await req(srv.base, "GET", "/api/u/admin/stats?days=30", { headers: asNewClient() })).json.total_tokens;
    assert.equal(await waitFor(async () => (await tokens()) === 42), true, "the upload reached the server");
  });

  test("the installed statusLine uploads the quotas", async () => {
    const { statusLine } = json(".claude", "settings.json");
    const resets = Math.floor(Date.now() / 1000) + 3600;
    assert.equal(await runCommand(statusLine.command, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12, resets_at: resets } } })), 0);
    const quotas = async () => (await req(srv.base, "GET", "/api/u/admin/quotas", { headers: asNewClient() })).json.quotas;
    assert.equal(await waitFor(async () => (await quotas()).some((q) => q.tool === "claude-code" && q.used_pct === 12)), true);
    if (WINDOWS) {
      assert.equal(await runCommand(statusLine.command, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 13, resets_at: resets } } }), "powershell"), 0);
      assert.equal(await waitFor(async () => (await quotas()).some((q) => q.tool === "claude-code" && q.used_pct === 13)), true);
    }
  });

  test("Windows Claude exec hooks upload from both cmd and PowerShell parents", { skip: !WINDOWS }, async () => {
    const handler = json(".claude", "settings.json").hooks.Stop.at(-1).hooks[0];
    // Emulate Claude's documented exec form inside each parent shell. The
    // handler itself is never reparsed as a shell command.
    const program = `const {spawnSync}=require('node:child_process');const h=${JSON.stringify(handler)};const r=spawnSync(h.command,h.args,{stdio:'inherit',windowsHide:true});process.exit(r.status??1);`;
    const encoded = Buffer.from(program).toString("base64");
    const bootstrap = `"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString())"`;
    for (const [index, shell] of ["cmd", "powershell"].entries()) {
      fs.writeFileSync(file(".claude", "projects", "-work", `shell-${index}.jsonl`), JSON.stringify({
        type: "assistant", sessionId: `shell-${index}`, timestamp: new Date().toISOString(),
        message: { id: `msg_install_shell_${index}`, model: "claude-test", usage: { input_tokens: 2, output_tokens: 3 } },
      }) + "\n");
      const command = (shell === "powershell" ? "& " : "") + bootstrap;
      assert.equal(await runCommand(command, "{}", shell), 0, `${shell} parent launches the exec hook`);
      assert.ok(await waitFor(async () => (await req(srv.base, "GET", "/api/u/admin/sessions")).json.sessions
        .some((s) => s.session_id === `shell-${index}` && s.tokens === 5)), `${shell} upload arrived`);
      assert.ok(await waitFor(() => !running(file(".claude"))));
    }
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
    assert.equal(json(".claude", "settings.json").hooks.Stop.length, 1);
    assert.equal(json(".claude", "settings.json").hooks.PostToolUse.length, 2);
    assert.equal(json(".codex", "hooks.json").hooks.Stop.length, 2);
    await install(); // back to the first key for the next tests
  });

  test("never replaces another statusLine unless asked, and still installs the hooks", async () => {
    const mine = { type: "command", command: "echo my status" };
    const { hooks, ...settings } = json(".claude", "settings.json");
    fs.writeFileSync(file(".claude", "settings.json"), JSON.stringify({ ...settings, statusLine: mine }));
    const r = await install({ AI_ACTIVITY_TOOLS: "claude-code" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /already has another statusLine, kept: tokens are sent/);
    assert.deepEqual(json(".claude", "settings.json").statusLine, mine);
    for (const event of CLAUDE_EVENTS) {
      assert.ok(JSON.stringify(json(".claude", "settings.json").hooks[event]).includes("ai-activity-claude-code.py"));
    }
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

  // Runs the install in a home of its own, removed afterwards.
  async function inFreshHome(prefix, fn) {
    const h = tempHome(prefix);
    try {
      await fn(h, (extra = {}) => install({ HOME: h, USERPROFILE: h, ...extra }));
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
    }
  }

  test("reinstall keeps other handlers in a shared Claude Code matcher group", () =>
    inFreshHome("ai-activity-install-shared-", async (h, run) => {
      const config = path.join(h, ".claude", "settings.json");
      fs.mkdirSync(path.dirname(config));
      const own = { type: "command", command: "python3 /old/path/ai-activity-claude-code.py --hook" };
      const other = { type: "command", command: "echo keep-this-hook" };
      const group = { matcher: "Bash", timeout: 30, hooks: [own, other] };
      fs.writeFileSync(config, JSON.stringify({ hooks: { Stop: [group] } }));
      const first = await run({ AI_ACTIVITY_TOOLS: "claude-code" });
      assert.equal(first.code, 0, first.out);
      const entries = JSON.parse(fs.readFileSync(config, "utf8")).hooks.Stop;
      assert.deepEqual(entries[0], { ...group, hooks: [other] });
      assert.equal(entries.length, 2, "the new handler is installed once");
      const snapshot = fs.readFileSync(config, "utf8");
      const second = await run({ AI_ACTIVITY_TOOLS: "claude-code" });
      assert.equal(second.code, 0, second.out);
      assert.equal(fs.readFileSync(config, "utf8"), snapshot, "reinstall is idempotent");
    }));

  test("a broken config stops the install before anything is written", () =>
    inFreshHome("ai-activity-install-broken-", async (h, run) => {
      fs.mkdirSync(path.join(h, ".claude"));
      fs.mkdirSync(path.join(h, ".codex"));
      fs.writeFileSync(path.join(h, ".codex", "hooks.json"), "{ not json");
      const r = await run();
      assert.notEqual(r.code, 0);
      assert.match(r.out, /hooks\.json is not valid JSON.*nothing was changed/);
      // Claude Code comes first in TOOLS order: it is not installed either.
      assert.deepEqual(fs.readdirSync(path.join(h, ".claude")), []);
      assert.deepEqual(fs.readdirSync(path.join(h, ".codex")), ["hooks.json"]);
    }));

  test("a symlinked config stays a link, its target updated", { skip: WINDOWS && "symlinks need privileges" }, () =>
    inFreshHome("ai-activity-install-link-", async (h, run) => {
      fs.mkdirSync(path.join(h, "dotfiles"));
      fs.mkdirSync(path.join(h, ".claude"));
      fs.writeFileSync(path.join(h, "dotfiles", "settings.json"), JSON.stringify({ model: "opus" }));
      fs.symlinkSync(path.join(h, "dotfiles", "settings.json"), path.join(h, ".claude", "settings.json"));
      const r = await run({ AI_ACTIVITY_TOOLS: "claude-code" });
      assert.equal(r.code, 0, r.out);
      assert.ok(fs.lstatSync(path.join(h, ".claude", "settings.json")).isSymbolicLink());
      const settings = JSON.parse(fs.readFileSync(path.join(h, "dotfiles", "settings.json"), "utf8"));
      assert.equal(settings.model, "opus");
      assert.deepEqual(settings.statusLine, STATUS_LINE);
    }));

  test("a URL that redirects is refused: the collectors' POSTs would not follow", () =>
    inFreshHome("ai-activity-install-redirect-", async (h, run) => {
      const redirect = http.createServer((q, res) => res.writeHead(308, { location: "https://ai.example.com" + q.url }).end());
      await new Promise((resolve) => redirect.listen(0, "127.0.0.1", resolve));
      try {
        const r = await run({ AI_ACTIVITY_URL: `http://127.0.0.1:${redirect.address().port}`, AI_ACTIVITY_TOOLS: "codex" });
        assert.notEqual(r.code, 0);
        assert.match(r.out, /redirects to https:\/\/ai\.example\.com\/api\/health/);
        assert.ok(!fs.existsSync(path.join(h, ".codex")), "nothing installed");
      } finally {
        redirect.close();
      }
    }));
});
