// Black-box harness: boots the real server on a random port with a temp DB,
// so these tests survive internal rewrites (routing, framework, modules).
import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER_ENTRY = path.join(ROOT, "server", "index.ts");
const USER_CLI = path.join(ROOT, "scripts", "user.ts");
const GEN_KEY = path.join(ROOT, "scripts", "gen-key.ts");

/** Session cookie used by req() when the call passes none (see startServer). */
const defaultCookies = new Map();
export const TEST_ADMIN = { username: "admin", password: "test-admin-pass" };

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

/**
 * Boot the server on a temp DB. Without a password, an admin account is
 * created and signed in, and req() uses that session by default (pass
 * `anon: true` for an anonymous call). With a password, an "admin" account
 * with that password is created but not signed in. `autoLogin: false`
 * without a password boots with no account at all.
 */
export async function startServer({ password = "", env = {}, autoLogin = true } = {}) {
  const auto = autoLogin && !password;
  if (auto) password = TEST_ADMIN.password;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-test-"));
  const dbPath = env.DB_PATH ?? path.join(dir, "t.db");
  try {
    // The first account, made from the CLI like on a real server. Once
    // only: a retry below reuses the same database.
    if (password) {
      const add = await userCli(dbPath, ["add", TEST_ADMIN.username], password);
      if (add.code !== 0) throw new Error(`admin create failed: ${add.out}`);
    }
    // node --test runs test files in parallel: another file can bind a freed
    // port between freePort() and listen(), so retry once with a fresh port.
    for (let attempt = 0; ; attempt++) {
      try {
        return await bootServer({ dir, dbPath, env, auto });
      } catch (e) {
        if (attempt >= 1 || !/EADDRINUSE/.test(String(e && e.message))) throw e;
      }
    }
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

async function bootServer({ dir, dbPath, env, auto }) {
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  proc.stderr.on("data", (c) => (stderr += c));
  proc.stdout.on("data", (c) => (stdout += c));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      // Only once this server logged its own listen: if another test's
      // server took the port, that one answers /api/health too.
      if (stdout.includes("listening on") && (await fetch(`${base}/api/health`)).ok) break;
    } catch { /* not up yet */ }
    if (proc.exitCode !== null) throw new Error(`server exited: ${stderr}`);
    // The pass path returns as soon as /api/health is OK; the cap only
    // bounds the failure case (type-stripping + migrations on a loaded
    // ARM64 runner, with every test file booting at once).
    if (i >= 600) {
      proc.kill();
      throw new Error(`server not healthy after 30 s: ${stderr || stdout}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (auto) defaultCookies.set(base, await login(base, TEST_ADMIN.username, TEST_ADMIN.password));
  return {
    base,
    dbPath,
    /** The one-time setup code the server printed, or null. */
    setupCode: () => stdout.match(/Setup code: (\S+)/)?.[1] ?? null,
    /** Sends SIGTERM and resolves with the exit code once the server is gone. */
    async kill() {
      // Ports are reused: forget the session, or a later server on this
      // port would receive the previous server's cookie.
      defaultCookies.delete(base);
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

/** type: content-type to send (default application/json on anything but GET; null sends none). It overrides a content-type in `headers`. */
export async function req(base, method, p, { body, key, cookie, raw, anon = false, type, headers: extra = {} } = {}) {
  if (cookie === undefined && !anon) cookie = defaultCookies.get(base);
  const headers = { ...extra };
  if (type === undefined) type = method === "GET" ? null : "application/json";
  if (type) headers["content-type"] = type;
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
    event_id: `msg_test_${Date.now()}_${seq}`,
    tool: "claude-code",
    session_id: "s1",
    prompt_id: `p-${seq}`,
    model: "claude-opus-5-5",
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 },
    occurred_at: Math.floor(Date.now() / 1000),
    ...over,
  };
}

/** One Codex response as the collector sends it (rollout token_usage_record). */
export function codexResponse(over = {}) {
  return {
    response_id: `resp_${Math.random().toString(36).slice(2)}`,
    session_id: "01a0b861-4cf4-7f10-8e5b-8d110992ee04",
    turn_id: "01a0b873-1871-70e2-9708-12e7c0fa6012",
    model: "gpt-6-astra",
    occurred_at: Math.floor(Date.now() / 1000) - 120,
    usage: { input_tokens: 300, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 10 },
    ...over,
  };
}

/** One OpenCode assistant message as the collector sends it (opencode.db). */
export function opencodeMessage(over = {}) {
  return {
    message_id: `msg_${Math.random().toString(36).slice(2)}`,
    session_id: "ses_f274ca90cffecUog3NvACbUq3j",
    provider_id: "anthropic",
    model_id: "claude-sonnet-5",
    occurred_at: Math.floor(Date.now() / 1000) - 120,
    usage: { input_tokens: 325, output_tokens: 1241, reasoning_tokens: 10, cache_read_tokens: 26353, cache_write_tokens: 0, total_tokens: 27929 },
    ...over,
  };
}

/** Run `npm run user -- <args>` against a test DB, piping the password on stdin. */
export function userCli(dbPath, args, password = "") {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [USER_CLI, ...args], {
      env: { ...process.env, DB_PATH: dbPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (out += c));
    proc.stdin.end(`${password}\n`);
    proc.on("exit", (code) => resolve({ code, out }));
  });
}

/** Log in and return the session cookie ("name=value"). */
export async function login(base, username, password) {
  const r = await req(base, "POST", "/api/auth/login", { body: { username, password }, anon: true });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.text}`);
  return r.headers.get("set-cookie").split(";")[0];
}

/** Run `npm run gen-key -- <name> [...extra]` against a test DB; resolves with the key. */
export function genKey(dbPath, name, ...extra) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [GEN_KEY, name, ...extra], { env: { ...process.env, DB_PATH: dbPath } });
    let out = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (out += c));
    proc.on("exit", (code) => (code === 0 ? (out.match(/ak_[0-9a-f]+/) ? resolve(out.match(/ak_[0-9a-f]+/)[0]) : reject(new Error(`no key in output: ${out}`))) : reject(new Error(out))));
  });
}

let pollIp = 0;
/**
 * Headers for a test that polls public reads (waitFor every 100 ms, far
 * faster than a dashboard): each call comes from its own client address,
 * so the per-client rate limit never trips the test.
 */
export const asNewClient = () => ({ "cf-connecting-ip": `198.19.${Math.floor(++pollIp / 250) % 250}.${pollIp % 250}` });

let signupIp = 0;
/**
 * Sign up through the public form (POST /api/auth/register). Each call uses
 * its own client address so the per-client sign-up limit never interferes.
 * Resolves with the response and the new session cookie.
 */
export async function register(base, body, ip = `198.18.${Math.floor(++signupIp / 250)}.${signupIp % 250}`) {
  const r = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => null);
  return { status: r.status, json, headers: r.headers, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? null };
}

/** An account's id, looked up by an admin session (the default one if omitted). */
export async function userId(base, username, cookie) {
  const users = (await req(base, "GET", "/api/users", { cookie })).json.users;
  return users.find((u) => u.username === username).id;
}

/**
 * Whether a process holds an exclusive flock on that file (missing means
 * free). Reads /proc/locks rather than trying the lock: a probe holding it
 * even briefly makes a collector's non-blocking attempt give up. Without
 * /proc (macOS), falls back to that probe; on Windows, to one on byte 0
 * (msvcrt.locking, like the Antigravity collector).
 */
export function isLocked(file) {
  if (!fs.existsSync(file)) return false;
  if (fs.existsSync("/proc/locks")) {
    const ino = String(fs.statSync(file).ino);
    // "1: FLOCK  ADVISORY  WRITE 1234 fd:01:5678 0 EOF"; "1: -> FLOCK …" lines are waiters.
    return fs.readFileSync("/proc/locks", "utf8").split("\n")
      .some((l) => /^\d+:\s+FLOCK\s+\S+\s+WRITE\s/.test(l) && l.split(/\s+/)[5]?.split(":")[2] === ino);
  }
  if (process.platform === "win32") {
    return spawnSync(process.env.PYTHON || "python", ["-c",
      "import msvcrt, sys\nf = open(sys.argv[1], 'r+b')\ntry: msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)\nexcept OSError: sys.exit(1)\nmsvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)",
      file]).status === 1;
  }
  return spawnSync("python3", ["-c",
    "import fcntl, sys\ntry: fcntl.flock(open(sys.argv[1], 'a'), fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(1)",
    file]).status === 1;
}

/** Whether a process has that text on its command line (e.g. a temp HOME in the script path). */
export const running = (text) => execFileSync("ps", ["-Aww", "-o", "args="], { encoding: "utf8" }).includes(text);

/**
 * Resolves once no process has that text on its command line, seen twice
 * 200 ms apart: an exit handler in this process (the OpenCode plugin) may
 * start the next run in between. False after `ms`.
 */
export async function processesGone(text, ms = 30000) {
  const end = Date.now() + ms;
  for (let clear = 0; clear < 2;) {
    clear = running(text) ? 0 : clear + 1;
    if (clear < 2 && Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, clear ? 200 : 100));
  }
  return true;
}

/**
 * Waits past UTC midnight when it is less than `margin` seconds away, so
 * the posts and the reads of a test that checks "today" fall on one day
 * (the server decides today when it reads).
 */
export async function awayFromMidnight(margin = 15) {
  const left = 86400000 - (Date.now() % 86400000);
  if (left < margin * 1000) await new Promise((r) => setTimeout(r, left + 1000));
}
