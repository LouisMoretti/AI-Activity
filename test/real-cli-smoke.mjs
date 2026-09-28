// Run only by the path-filtered, manually runnable CLI smoke workflow.
// Real tool binaries talk to a deterministic local model API;
// the one-command installer must make their native hooks upload the usage.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, newDevice, req, processesGone } from "./helpers.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const require = createRequire(import.meta.url);
async function waitFor(check, ms = 30000) {
  const end = Date.now() + ms;
  do {
    if (await check()) return true;
    await sleep(100);
  } while (Date.now() < end);
  return false;
}

function run(bin, args, env, { cwd, input = "", timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const nodeScript = bin.endsWith(".js");
    const child = spawn(nodeScript ? process.execPath : bin, nodeScript ? [bin, ...args] : args,
      { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (part) => { output += part; });
    child.stderr.on("data", (part) => { output += part; });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const timer = setTimeout(() => child.kill(), timeout);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

function interactiveClaudeUnix(cli, env, cwd, uploaded) {
  return new Promise((resolve, reject) => {
    const quoted = "'" + cli.replaceAll("'", "'\\''") + "'";
    const child = spawn("script", ["-q", "-e", "-c",
      `${quoted} --model claude-sonnet-4-5`, "/dev/null"],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let acceptedKey = false;
    let stopping = false;
    child.stdout.on("data", (part) => {
      output += part;
      if (!acceptedKey && output.includes("ANTHROPIC_API_KEY") && output.includes("recommended")) {
        acceptedKey = true;
        child.stdin.write("\x1b[A\r");
        setTimeout(() => child.stdin.write("Say hello.\r"), 1500);
      }
    });
    child.stderr.on("data", (part) => { output += part; });
    child.stdin.on("error", () => {});
    const poll = setInterval(async () => {
      try {
        if (!stopping && await uploaded()) {
          stopping = true;
          child.stdin.write("\x03");
          setTimeout(() => child.kill(), 1000);
        }
      } catch { /* surface the main assertion below */ }
    }, 500);
    const limit = setTimeout(() => child.kill(), 20000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearInterval(poll); clearTimeout(limit);
      resolve({ code, output });
    });
  });
}

function interactiveClaudeWindows(cli, env, cwd, uploaded) {
  const pty = require(path.join(process.env.CLI_ROOT, "node-pty"));
  return new Promise((resolve) => {
    const child = pty.spawn(cli, ["--model", "claude-sonnet-4-5"],
      { cwd, env, cols: 120, rows: 40, useConptyDll: true });
    let output = "";
    let trusted = false;
    let acceptedKey = false;
    let stopping = false;
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearInterval(poll); clearTimeout(limit);
      resolve({ code, output });
    };
    child.onData((part) => {
      output += part;
      if (!trusted && output.includes("Quick") && output.includes("safety") && output.includes("trust")) {
        trusted = true;
        child.write("\x1b[B\r");
      }
      if (!acceptedKey && output.includes("ANTHROPIC_API_KEY") && output.includes("recommended")) {
        acceptedKey = true;
        child.write("\x1b[A\r");
        setTimeout(() => child.write("Say hello.\r"), 1500);
      }
    });
    const poll = setInterval(async () => {
      try {
        if (!stopping && await uploaded()) {
          stopping = true;
          child.write("\x03");
          setTimeout(() => child.kill(), 1000);
        }
      } catch { /* surface the main assertion below */ }
    }, 500);
    const limit = setTimeout(() => { child.kill(); finish(null); }, 30000);
    child.onExit(({ exitCode }) => finish(exitCode));
  });
}

const interactiveClaude = process.platform === "win32" ? interactiveClaudeWindows : interactiveClaudeUnix;

async function localServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)) };
}

function sse(response, events) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  response.end();
}

async function modelServer(tool) {
  const calls = [];
  const srv = await localServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    if (request.method === "HEAD" && request.url === "/api/hello") return response.writeHead(200).end();
    const url = new URL(request.url, "http://localhost");
    const expectedPath = tool === "claude-code" ? url.pathname === "/v1/messages"
      : url.pathname === "/v1/responses";
    if (request.method !== "POST" || !expectedPath) {
      return response.writeHead(404).end();
    }
    const body = JSON.parse(raw);
    if (tool === "opencode") assert.ok(["gpt-test", "gpt-5.4-nano"].includes(body.model));
    else assert.equal(body.model, tool === "claude-code" ? "claude-sonnet-4-5" : "gpt-test");
    calls.push(body);
    if (tool === "claude-code") {
      const message = { id: "msg_local_smoke", type: "message", role: "assistant", content: [],
        model: "claude-sonnet-4-5", stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 0 } };
      return sse(response, [
        ["message_start", { type: "message_start", message }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello." } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 7 } }],
        ["message_stop", { type: "message_stop" }],
      ]);
    }
    const item = { id: "msg_local_smoke", type: "message", role: "assistant",
      content: [{ type: "output_text", text: "Hello.", annotations: [] }] };
    const answer = { id: "resp_local_smoke", object: "response", created_at: Math.floor(Date.now() / 1000),
      model: "gpt-test", output: [item], status: "completed",
      usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    sse(response, [
      ["response.created", { type: "response.created", response: { ...answer, output: [], status: "in_progress" } }],
      ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }],
      ["response.content_part.added", { type: "response.content_part.added", item_id: item.id, output_index: 0,
        content_index: 0, part: { type: "output_text", text: "", annotations: [] } }],
      ["response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index: 0,
        content_index: 0, delta: "Hello." }],
      ["response.output_text.done", { type: "response.output_text.done", item_id: item.id, output_index: 0,
        content_index: 0, text: "Hello." }],
      ["response.content_part.done", { type: "response.content_part.done", item_id: item.id, output_index: 0,
        content_index: 0, part: item.content[0] }],
      ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
      ["response.completed", { type: "response.completed", response: answer }],
    ]);
  });
  return { ...srv, calls };
}

async function ingestProxy(upstream, tool, key) {
  const uploads = [];
  const srv = await localServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    const p = request.url;
    if (request.method === "POST" && p === `/api/ingest/${tool}` && raw !== "{}") {
      assert.equal(request.headers.authorization, `Bearer ${key}`);
      assert.match(request.headers["content-type"] ?? "", /^application\/json\b/i);
      const body = JSON.parse(raw);
      assert.deepEqual(body.collector.name, tool);
      uploads.push(body);
    }
    const sent = await fetch(upstream + p, { method: request.method,
      headers: { ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        ...(request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {}) },
      body: request.method === "GET" ? undefined : raw });
    response.writeHead(sent.status, { "content-type": sent.headers.get("content-type") ?? "application/json" });
    response.end(Buffer.from(await sent.arrayBuffer()));
  });
  return { ...srv, uploads };
}

async function smoke(tool, cli) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `ai-activity-real-${tool}-`));
  const work = path.join(home, "work");
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(home, ".codex"));
  if (process.platform === "win32") {
    fs.mkdirSync(path.join(home, "AppData", "Roaming"), { recursive: true });
    fs.mkdirSync(path.join(home, "AppData", "Local"), { recursive: true });
  }
  if (tool === "claude-code") fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.283", theme: "dark",
    projects: { [work]: { hasTrustDialogAccepted: true } },
  }));
  const app = await startServer();
  const key = (await newDevice(app.base, `real-${tool}`)).key;
  const model = await modelServer(tool);
  const ingest = await ingestProxy(app.base, tool, key);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"),
    ...(process.platform === "win32" ? { APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local") } : {}),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    AI_ACTIVITY_URL: ingest.base, AI_ACTIVITY_KEY: key, AI_ACTIVITY_TOOLS: tool,
    ANTHROPIC_BASE_URL: model.base, ANTHROPIC_API_KEY: "local-test-key",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1",
    MOCK_API_KEY: "local-test-key", OPENCODE_DISABLE_AUTOUPDATE: "1" };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    const install = process.platform === "win32"
      ? await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
        `irm ${app.base}/install.ps1 | iex`], env, { cwd: work })
      : await run("sh", ["-c", `curl -fsSL ${app.base}/install.sh | sh`], env, { cwd: work });
    assert.equal(install.code, 0, install.output);
    const config = path.join(home, ".codex", "config.toml");
    if (tool === "codex") {
      fs.writeFileSync(config, `model = "gpt-test"
model_provider = "mock"
[model_providers.mock]
name = "mock"
base_url = "${model.base}/v1"
wire_api = "responses"
env_key = "MOCK_API_KEY"
`);
    }
    if (tool === "opencode") {
      fs.writeFileSync(path.join(home, ".config", "opencode", "opencode.json"), JSON.stringify({
        provider: { openai: { options: { baseURL: `${model.base}/v1`, apiKey: "local-test-key" },
          models: { "gpt-test": { name: "Local test", limit: { context: 200000, output: 4096 } } } } },
        model: "openai/gpt-test",
      }));
    }
    const before = Date.now();
    const summary = async () => (await req(app.base, "GET", `/api/u/admin/summary?tool=${tool}`)).json.total;
    const result = tool === "claude-code"
      ? await interactiveClaude(cli, env, work, async () => (await summary()).events === 1)
      : await run(cli, tool === "codex"
        ? ["exec", "--skip-git-repo-check", "--dangerously-bypass-hook-trust",
          "-m", "gpt-test", "Say hello."]
        : ["--log-level", "DEBUG", "run", "--model", "openai/gpt-test", "--format", "json", "Say hello."],
      env, { cwd: work });
    if (tool === "codex") assert.equal(result.code, 0, result.output.slice(-2000));
    const logDir = path.join(home, ".local", "share", "opencode", "log");
    const logs = tool === "opencode" && fs.existsSync(logDir)
      ? fs.readdirSync(logDir).sort().slice(-1).map((file) => fs.readFileSync(path.join(logDir, file), "utf8").slice(-4000)).join("\n")
      : "";
    assert.ok(model.calls.length >= 1, `CLI must use the local model API (exit ${result.code}): ` +
      `${result.output.slice(-3000)}\nOpenCode log: ${logs}`);
    assert.ok(await waitFor(async () => (await summary()).events === 1),
      `real ${tool} produced no collector upload; CLI output: ${result.output.slice(-1200)}`);
    assert.ok(await processesGone(home));
    assert.equal((await summary()).tokens, 19);
    assert.ok(ingest.uploads.some((body) => body.messages?.some((message) => message.usage.input_tokens === 12 &&
      message.usage.output_tokens === 7)));
    console.log(`${tool}: real CLI, hook, collector and ingestion passed in ${Date.now() - before} ms`);
  } finally {
    await processesGone(home);
    await ingest.close();
    await model.close();
    await app.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const cliRoot = process.env.CLI_ROOT;
test("real Claude Code CLI calls the installed statusLine after a local chat", () =>
  smoke("claude-code", process.env.CLAUDE_CLI || (cliRoot
    ? path.join(cliRoot, "@anthropic-ai", "claude-code", "bin", "claude.exe") : "claude")));
test("real Codex CLI calls the installed hook after a local chat", () =>
  smoke("codex", process.env.CODEX_CLI || (cliRoot
    ? path.join(cliRoot, "@openai", "codex", "bin", "codex.js") : "codex")));
test("real OpenCode CLI loads the installed plugin after a local chat", () =>
  smoke("opencode", process.env.OPENCODE_CLI || (cliRoot
    ? path.join(cliRoot, "opencode-ai", "bin", "opencode.exe") : "opencode")));
