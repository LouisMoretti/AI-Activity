// Black-box harness: boots the real server on a random port with a temp DB,
// so these tests survive internal rewrites (routing, framework, modules).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER_ENTRY = path.join(ROOT, "server", "index.ts");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export async function startServer({ password = "", env = {} } = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-test-"));
  const dbPath = path.join(dir, "t.db");
  const proc = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, DASHBOARD_PASSWORD: password, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (c) => (stderr += c));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch { /* not up yet */ }
    if (proc.exitCode !== null) throw new Error(`server exited: ${stderr}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    base,
    dbPath,
    /** Sends SIGTERM and resolves with the exit code once the server is gone. */
    async kill() {
      if (proc.exitCode !== null || proc.signalCode !== null) return proc.exitCode;
      proc.kill();
      return new Promise((r) => proc.once("exit", (code) => r(code)));
    },
    async stop() {
      await this.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function req(base, method, p, { body, key, cookie, raw } = {}) {
  const headers = {};
  if (body !== undefined || raw !== undefined) headers["content-type"] = "application/json";
  if (key) headers.authorization = `Bearer ${key}`;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + p, {
    method,
    headers,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers, text };
}

export async function newDevice(base, name = "test-device", cookie) {
  const r = await req(base, "POST", "/api/devices", { body: { name }, cookie });
  if (r.status !== 200) throw new Error(`device create failed: ${r.status} ${r.text}`);
  return r.json;
}

let seq = 0;
export function event(over = {}) {
  seq += 1;
  return {
    event_id: `e-${Date.now()}-${seq}`,
    tool: "claude-code",
    session_id: "s1",
    prompt_id: `p-${seq}`,
    model: "claude-opus-5-5",
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 },
    occurred_at: Math.floor(Date.now() / 1000),
    ...over,
  };
}
