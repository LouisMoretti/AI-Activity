// Real Antigravity CLI smoke (issue #189): the installed hook uploads measured
// usage from a real `agy -p` chat against a local Gemini stub through the
// local receiver and the real app API. Skips when agy is missing.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, newDevice, req, tempHome } from "./helpers.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, ms = 30000) {
  const end = Date.now() + ms;
  do {
    if (await check()) return true;
    await sleep(250);
  } while (Date.now() < end);
  return false;
}

function agyVersion() {
  try {
    const r = spawnSync("agy", ["--version"], { encoding: "utf8", timeout: 10000 });
    const m = String(r.stdout || r.stderr || "").match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

async function localServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function run(bin, args, env, { cwd, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (p) => { output += p; });
    child.stderr.on("data", (p) => { output += p; });
    const timer = setTimeout(() => { child.kill(); resolve({ code: null, output }); }, timeout);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

// File listing for CI failure diagnostics: where did agy write its metadata,
// did the installer land hooks.json, did any worker leave state behind?
function tree(root, depth = 3) {
  const out = [];
  const walk = (dir, left) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let suffix = "";
      if (!entry.isDirectory()) {
        try {
          suffix = ` (${fs.statSync(full).size}b)`;
        } catch {
          suffix = " (unreadable)";
        }
      }
      out.push(path.relative(root, full) + (entry.isDirectory() ? "/" : suffix));
      if (entry.isDirectory() && left > 0) walk(full, left - 1);
    }
  };
  try {
    if (!fs.statSync(root).isDirectory()) return `(not a directory: ${root})`;
  } catch {
    return `(missing: ${root})`;
  }
  walk(root, depth);
  return out.length ? out.join("\n") : "(empty)";
}

function readIf(pathname, max = 2000) {
  try {
    return fs.readFileSync(pathname, "utf8").slice(0, max);
  } catch {
    return `(unreadable: ${pathname})`;
  }
}

// agy's own log lines about hooks: did the app fire ours, and what did the
// hook print? Only matching lines, capped, so no chat content is dumped.
function hookLogLines(logDir, max = 3000) {
  let files = [];
  try {
    files = fs.readdirSync(logDir).filter((f) => /^cli(-.*)?\.log$/.test(f))
      .map((f) => path.join(logDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch {
    return `(unreadable: ${logDir})`;
  }
  if (!files.length) return "(no agy cli log)";
  const lines = readIf(files[0], 200000).split("\n")
    .filter((line) => /hook|ai-activity/i.test(line));
  const tail = lines.join("\n").slice(-max);
  return tail || "(no hook lines in agy cli log)";
}

test("real Antigravity CLI uploads measured usage through the installed hook", async (t) => {
  const version = agyVersion();
  if (!version) {
    t.skip("agy not on PATH");
    return;
  }
  const home = tempHome("ai-activity-real-antigravity-");
  const work = path.join(home, "work");
  fs.mkdirSync(work, { recursive: true });
  let app = null, stub = null, ingest = null;
  try {
    app = await startServer();
    const key = (await newDevice(app.base, "real-antigravity")).key;
    // Deterministic Gemini stub: title call gets a tiny reply, the real turn
    // reports 12 input / 7 output with an explicit model and response id.
    stub = await localServer(async (request, response) => {
      let raw = "";
      for await (const part of request) raw += part;
      if (request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      const title = raw.includes("conversation title generator");
      const chunk = title
        ? { candidates: [{ content: { parts: [{ text: "Title" }], role: "model" }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } }
        : { candidates: [{ content: { parts: [{ text: "Hello." }], role: "model" }, finishReason: "STOP" }],
          modelVersion: "gemini-test-smoke", responseId: "resp-smoke-1",
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, totalTokenCount: 19 } };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify(chunk)}\n\n`);
    });
    // Ingest proxy: captures the exact outbound payload, forwards to the app.
    const uploads = [];
    ingest = await localServer(async (request, response) => {
      let raw = "";
      for await (const part of request) raw += part;
      if (request.method === "POST" && request.url === "/api/ingest/antigravity" && raw !== "{}") {
        assert.equal(request.headers.authorization, `Bearer ${key}`);
        const body = JSON.parse(raw);
        assert.equal(body.collector.name, "antigravity");
        uploads.push(body);
      }
      const sent = await fetch(app.base + request.url, {
        method: request.method,
        headers: {
          ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
          ...(request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {}),
        },
        body: request.method === "GET" ? undefined : raw,
      });
      response.writeHead(sent.status, {
        "content-type": sent.headers.get("content-type") ?? "application/json",
        ...(sent.headers.get("retry-after") ? { "retry-after": sent.headers.get("retry-after") } : {}),
      });
      response.end(Buffer.from(await sent.arrayBuffer()));
    });
    const geminiHome = path.join(home, ".gemini", "antigravity-cli");
    fs.mkdirSync(geminiHome, { recursive: true });
    fs.writeFileSync(path.join(geminiHome, "settings.json"), JSON.stringify({ modelProvider: "gemini" }));
    const env = {
      ...process.env, HOME: home, USERPROFILE: home, GEMINI_CLI_HOME: path.join(home, ".gemini"),
      AI_ACTIVITY_URL: ingest.base, AI_ACTIVITY_KEY: key, AI_ACTIVITY_TOOLS: "antigravity",
      GEMINI_API_KEY: "dummy", GOOGLE_GEMINI_BASE_URL: stub.base,
    };
    // The hook installer ships as install.sh (sh) and install.ps1
    // (PowerShell): use the shell of the platform under test, like
    // real-cli-smoke.mjs. Both read AI_ACTIVITY_* from the environment.
    const install = process.platform === "win32"
      ? await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command", `irm ${app.base}/install.ps1 | iex`], env, { cwd: work })
      : await run("sh", ["-c", `curl -fsSL ${app.base}/install.sh | AI_ACTIVITY_URL=${ingest.base} AI_ACTIVITY_KEY=${key} AI_ACTIVITY_TOOLS=antigravity sh`], env, { cwd: work });
    assert.equal(install.code, 0, install.output.slice(-2000));
    const chat = await run("agy", ["-p", "Say hello.", "--output-format", "json", "--print-timeout", "20s"], env, { cwd: work });
    assert.match(chat.output, /"status":"SUCCESS"/, chat.output.slice(-2000));
    const summary = async () => (await req(app.base, "GET", "/api/u/admin/summary?tool=antigravity")).json.total;
    const uploaded = await waitFor(async () => (await summary()).events >= 1);
    if (!uploaded) {
      const gemini = path.join(home, ".gemini");
      const diag = [
        `chat output: ${chat.output.slice(-1200)}`,
        `hooks.json: ${readIf(path.join(gemini, "config", "hooks.json"))}`,
        `agy cli.log hook lines:\n${hookLogLines(path.join(gemini, "antigravity-cli", "log"))}`,
        `isolated .gemini tree:\n${tree(gemini)}`,
        `isolated .cache/ai-activity tree:\n${tree(path.join(home, ".cache", "ai-activity"))}`,
      ].join("\n");
      assert.fail(`real agy produced no collector upload (agy ${version});\n${diag}`);
    }
    const message = uploads.flatMap((b) => b.messages).find((m) => m.response_id === "resp-smoke-1");
    assert.ok(message, "the installed hook sent the measured response id");
    assert.equal(message.usage.input_tokens, 12);
    assert.equal(message.usage.output_tokens, 7);
    assert.equal(message.model, "gemini-test-smoke");
    assert.ok((await summary()).tokens >= 19, "measured tokens reached the API");
    assert.ok(!JSON.stringify(uploads).includes("Say hello."));
  } finally {
    if (ingest) await ingest.close();
    if (stub) await stub.close();
    if (app) await app.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
