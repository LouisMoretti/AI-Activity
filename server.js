import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  openDb,
  nowSec,
  getDefaultUserId,
  findDeviceByKey,
  createDevice,
  revokeDevice,
  insertUsageEvent,
  insertQuotaSnapshot,
  latestQuotas,
  usageTotals,
  dailyBuckets,
  recentSessions,
} from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "dashboard.db");
const VIEWER_PASSWORD = process.env.DASHBOARD_PASSWORD || "";

const db = openDb(DB_PATH);
const viewerSessions = new Set();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ---------- helpers ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(text);
}

function readBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        tooLarge = true;
        return; // drain the rest, then reject on end
      }
      if (!tooLarge) chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = (await readBody(req)) || "{}";
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function viewerAuthed(req) {
  if (!VIEWER_PASSWORD) return true; // open on localhost testing without password
  const token = parseCookies(req).dash_session;
  return Boolean(token && viewerSessions.has(token));
}

function bearerKey(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function toInt(n, fallback = 0) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return fallback;
  return Math.floor(v);
}

function toSec(ts, fallback) {
  const v = Number(ts);
  if (!Number.isFinite(v)) return fallback;
  // Accept milliseconds as well as seconds.
  return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
}

/**
 * Normalize an ingest payload.
 *
 * Accepts the documented flat contract AND a near-raw Claude Code
 * statusLine shape ({ model: {id}, cost: {...}, context_window:
 * { current_usage: {...} }, rate_limits: {...} }).
 *
 * Only incremental token counts (context_window.current_usage / usage)
 * are stored. Cumulative totals (total_input_tokens, total_cost_usd)
 * are deliberately ignored for summation.
 */
function normalizeIngest(body) {
  const src = body && typeof body === "object" ? body : {};
  const now = nowSec();

  const nested = src.context_window?.current_usage;
  const flat = src.usage;
  const u = (flat && typeof flat === "object" ? flat : null) ||
    (nested && typeof nested === "object" ? nested : null) || {};

  let model = null;
  if (typeof src.model === "string") model = src.model;
  else if (src.model && typeof src.model === "object") {
    model = src.model.id || src.model.display_name || null;
  }

  let tool = typeof src.tool === "string" ? src.tool : "claude-code";
  if (tool === "claude") tool = "claude-code";

  // Estimated cost: ONLY an explicit delta is accepted. The statusLine
  // cost.total_cost_usd field is cumulative per session and must never
  // be summed, so it is ignored here by design.
  const delta =
    src.cost_estimated_usd_delta ?? src.cost_estimated_usd ?? null;
  const costDelta =
    delta === null || delta === undefined ? null : Number(delta);
  const costOk =
    costDelta !== null && Number.isFinite(costDelta) && costDelta >= 0;

  const limits = src.rate_limits && typeof src.rate_limits === "object"
    ? src.rate_limits
    : {};
  const quotas = [];
  for (const key of Object.keys(limits)) {
    const w = limits[key];
    if (!w || typeof w !== "object") continue;
    const pct = Number(w.used_percentage ?? w.used_pct);
    if (!Number.isFinite(pct) || pct < 0) continue;
    quotas.push({
      limit_type: String(key),
      used_pct: pct,
      resets_at: w.resets_at !== undefined && w.resets_at !== null
        ? toSec(w.resets_at, null)
        : null,
    });
  }

  return {
    event_id: typeof src.event_id === "string" && src.event_id
      ? src.event_id
      : (typeof src.eventId === "string" && src.eventId) || randomUUID(),
    event_id_generated: !(src.event_id || src.eventId),
    tool,
    session_id: src.session_id ?? src.sessionId ?? null,
    prompt_id: src.prompt_id ?? src.promptId ?? null,
    model,
    input_tokens: toInt(u.input_tokens, 0),
    output_tokens: toInt(u.output_tokens, 0),
    cache_read_tokens: toInt(
      u.cache_read_input_tokens ?? u.cache_read_tokens, 0
    ),
    cache_write_tokens: toInt(
      u.cache_creation_input_tokens ?? u.cache_write_tokens, 0
    ),
    cost_estimated_usd: costOk ? costDelta : null,
    occurred_at: src.occurred_at !== undefined
      ? toSec(src.occurred_at, now)
      : now,
    account_ref: typeof src.account_ref === "string" && src.account_ref
      ? src.account_ref
      : "default",
    quotas,
  };
}

// ---------- static ----------

function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "forbidden");
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA fallback for unknown non-API paths.
      if (!p.startsWith("/api/")) {
        serveFile(res, path.join(PUBLIC_DIR, "index.html"));
        return;
      }
      sendJson(res, 404, { error: "not found" });
      return;
    }
    serveFile(res, file);
  });
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      sendText(res, 404, "not found");
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(data);
  });
}

// ---------- routes ----------

async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const { pathname, searchParams } = url;

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  // --- viewer auth ---
  if (req.method === "GET" && pathname === "/api/auth/status") {
    sendJson(res, 200, {
      locked: Boolean(VIEWER_PASSWORD),
      authenticated: viewerAuthed(req),
    });
    return;
  }
  if (req.method === "POST" && pathname === "/api/auth/login") {
    const raw = await readBody(req);
    let password = "";
    try {
      password = JSON.parse(raw || "{}").password || "";
    } catch { /* ignore */ }
    if (!VIEWER_PASSWORD || password === VIEWER_PASSWORD) {
      const token = randomUUID();
      viewerSessions.add(token);
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "set-cookie": `dash_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`,
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    sendJson(res, 401, { error: "invalid password" });
    return;
  }
  if (req.method === "POST" && pathname === "/api/auth/logout") {
    const token = parseCookies(req).dash_session;
    if (token) viewerSessions.delete(token);
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "dash_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0",
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- ingestion (device key, NOT viewer auth) ---
  if (req.method === "POST" && pathname === "/api/ingest") {
    const key = bearerKey(req);
    if (!key) {
      sendJson(res, 401, {
        error: "missing Authorization: Bearer <device key> header",
      });
      return;
    }
    const device = findDeviceByKey(db, key);
    if (!device) {
      sendJson(res, 401, { error: "unknown or revoked device key" });
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      sendJson(res, err?.status || 400, { error: String(err?.message || "invalid JSON") });
      return;
    }
    if (body.tool && !["claude-code", "claude"].includes(body.tool)) {
      sendJson(res, 400, {
        error: "unsupported tool (this server currently ingests claude-code only)",
      });
      return;
    }
    const ev = normalizeIngest(body);
    const received = nowSec();
    const result = insertUsageEvent(db, {
      event_id: ev.event_id,
      device_id: device.id,
      user_id: device.user_id,
      tool: ev.tool,
      session_id: ev.session_id,
      prompt_id: ev.prompt_id,
      model: ev.model,
      input_tokens: ev.input_tokens,
      output_tokens: ev.output_tokens,
      cache_read_tokens: ev.cache_read_tokens,
      cache_write_tokens: ev.cache_write_tokens,
      cost_estimated_usd: ev.cost_estimated_usd,
      occurred_at: ev.occurred_at,
      received_at: received,
    });
    // Quotas are snapshots: latest value wins, never summed.
    for (const q of ev.quotas) {
      insertQuotaSnapshot(db, {
        device_id: device.id,
        user_id: device.user_id,
        account_ref: ev.account_ref,
        tool: ev.tool,
        limit_type: q.limit_type,
        used_pct: q.used_pct,
        resets_at: q.resets_at,
        measured_at: received,
      });
    }
    sendJson(res, 200, {
      ok: true,
      deduped: !result.inserted,
      event_id: ev.event_id,
    });
    return;
  }

  // --- viewer-protected APIs ---
  const needsViewer = pathname.startsWith("/api/") &&
    !pathname.startsWith("/api/health") &&
    !pathname.startsWith("/api/auth/");
  if (needsViewer && !viewerAuthed(req)) {
    sendJson(res, 401, { error: "viewer login required" });
    return;
  }

  const userId = getDefaultUserId(db); // multi-user login comes later

  if (req.method === "GET" && pathname === "/api/stats") {
    const days = Math.min(Math.max(Number(searchParams.get("days")) || 30, 1), 730);
    const tool = searchParams.get("tool") || null;
    const since = nowSec() - days * 86400;
    const totals = usageTotals(db, userId, since, tool);
    sendJson(res, 200, {
      range_days: days,
      tool,
      ...totals,
      total_tokens: Number(totals.total_tokens),
      has_data: Number(totals.events) > 0,
      provenance: "measured device events (incremental token counts only)",
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/activity") {
    const days = Math.min(Math.max(Number(searchParams.get("days")) || 364, 1), 730);
    const tool = searchParams.get("tool") || null;
    const since = nowSec() - days * 86400;
    sendJson(res, 200, {
      days: dailyBuckets(db, userId, since, tool),
      provenance: "measured device events",
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/quotas") {
    const rows = latestQuotas(db, userId);
    sendJson(res, 200, {
      quotas: rows.map((q) => ({
        account_ref: q.account_ref,
        tool: q.tool,
        limit_type: q.limit_type,
        used_pct: q.used_pct,
        resets_at: q.resets_at,
        measured_at: q.measured_at,
      })),
      provenance: "latest snapshot provided by the account (never summed across devices)",
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/sessions") {
    const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 10, 1), 50);
    sendJson(res, 200, {
      sessions: recentSessions(db, userId, limit),
      provenance: "grouped by unique session id from device events",
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/billing") {
    const subs = db
      .prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId);
    const records = db
      .prepare("SELECT * FROM billing_records WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId);
    const allTime = usageTotals(db, userId, 0, null);
    sendJson(res, 200, {
      subscriptions: subs,
      billing_records: records,
      estimated_api_equivalent_usd: Number(allTime.estimated_usd || 0),
      disclaimer: "Paid amounts are manually entered invoices. The API-equivalent estimate is derived from measured tokens and is neither an invoice nor a saving.",
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/billing/subscription") {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      sendJson(res, err?.status || 400, { error: String(err?.message || "invalid JSON") });
      return;
    }
    if (!body.tool || !body.plan_name || !Number.isFinite(Number(body.amount))) {
      sendJson(res, 400, {
        error: "tool, plan_name and numeric amount are required",
      });
      return;
    }
    const info = db
      .prepare(
        `INSERT INTO subscriptions
          (user_id, tool, plan_name, amount, currency, period_start, period_end, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        userId,
        String(body.tool),
        String(body.plan_name),
        Number(body.amount),
        String(body.currency || "USD"),
        body.period_start || null,
        body.period_end || null,
        body.note || null,
        nowSec()
      );
    sendJson(res, 200, { ok: true, id: Number(info.lastInsertRowid) });
    return;
  }

  if (req.method === "GET" && pathname === "/api/devices") {
    const rows = db
      .prepare(
        "SELECT id, name, key_prefix, revoked, created_at FROM devices WHERE user_id = ? ORDER BY id"
      )
      .all(userId);
    sendJson(res, 200, { devices: rows });
    return;
  }

  if (req.method === "POST" && pathname === "/api/devices") {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      sendJson(res, err?.status || 400, { error: String(err?.message || "invalid JSON") });
      return;
    }
    const created = createDevice(db, {
      userId,
      name: String(body.name || "unnamed device").slice(0, 80),
    });
    // The full key is returned once and never stored in plain text.
    sendJson(res, 200, { ok: true, id: created.id, key: created.key });
    return;
  }

  const revokeMatch = pathname.match(/^\/api\/devices\/(\d+)\/revoke$/);
  if (req.method === "POST" && revokeMatch) {
    revokeDevice(db, Number(revokeMatch[1]));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res);
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    const status = err?.status || 500;
    if (!res.headersSent) sendJson(res, status, { error: String(err?.message || err) });
  });
});

server.listen(PORT, () => {
  console.log(`AI usage dashboard listening on http://localhost:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
  if (!VIEWER_PASSWORD) console.log("Viewer auth: disabled (no DASHBOARD_PASSWORD set)");
});
