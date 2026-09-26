import { nowSec } from "../db/schema.ts";

export interface NormalizedQuota {
  limit_type: string;
  used_pct: number;
  resets_at: number | null;
}

/** One API response's consumption, keyed by its provider message id. */
export interface NormalizedMessage {
  /** Anthropic message id (msg_…): the dedup key, stored as event_id. */
  event_id: string;
  session_id: string | null;
  prompt_id: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  context_window_size: number | null;
  context_used_pct: number | null;
  occurred_at: number;
  /** The device's UTC offset at occurred_at, in minutes; null when not sent. */
  utc_offset_min: number | null;
}

/** Context fill of a session at measurement time (a gauge, never summed). */
export interface NormalizedContext {
  session_id: string;
  used_pct: number | null;
  window_size: number | null;
}

export interface NormalizedBatch {
  tool: string;
  messages: NormalizedMessage[];
  quotas: NormalizedQuota[];
  account_ref: string;
  /** When the quotas and context were observed (capped at now). */
  measured_at: number;
  context: NormalizedContext | null;
  /** The payload was one flat event rather than a { messages: [] } batch. */
  single: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object";

function toInt(n: unknown, fallback = 0): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return fallback;
  return Math.floor(v);
}

function toSec(ts: unknown, fallback: number): number;
function toSec(ts: unknown, fallback: null): number | null;
function toSec(ts: unknown, fallback: number | null): number | null {
  const v = Number(ts);
  if (!Number.isFinite(v)) return fallback;
  // Accept milliseconds as well as seconds.
  return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
}

/** Non-negative finite number, or null when absent/invalid (never 0 by default). */
function optNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const str = (v: unknown): string | null =>
  v === undefined || v === null ? null : String(v);

/** A skewed device clock must not put usage in the future (heatmap, streaks, "today"). */
const eventTime = (v: unknown, now: number) => (v !== undefined ? Math.min(toSec(v, now), now) : now);

/**
 * A UTC offset in minutes as the collectors send it (east of UTC positive,
 * like Python's tm_gmtoff / 60): -12:00 to +14:00, in quarter hours.
 * Anything else is dropped, and the event then counts as UTC.
 */
function utcOffset(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= -720 && n <= 840 && n % 15 === 0 ? n : null;
}

function modelOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  return isObj(v) ? str(v.id || v.display_name || null) : null;
}

/** Anthropic message ids look like msg_011CfQ1q3CGJXyE6UmWhehGs. */
const MESSAGE_ID = /^msg_[A-Za-z0-9_-]{1,200}$/;

/**
 * One message, or null without an Anthropic message id: a usage snapshot
 * that cannot be tied to one API response (e.g. an old collector's random
 * per-fire UUID) would be counted again on every re-fire.
 */
function toMessage(m: Obj, now: number): NormalizedMessage | null {
  const id = [m.message_id, m.event_id, m.eventId].find((v) => typeof v === "string" && MESSAGE_ID.test(v));
  if (typeof id !== "string") return null;
  const u: Obj = isObj(m.usage) ? m.usage : {};
  const size = optNum(m.context_window_size);
  return {
    event_id: id,
    session_id: str(m.session_id ?? m.sessionId),
    prompt_id: str(m.prompt_id ?? m.promptId),
    model: modelOf(m.model),
    input_tokens: toInt(u.input_tokens),
    output_tokens: toInt(u.output_tokens),
    cache_read_tokens: toInt(u.cache_read_input_tokens ?? u.cache_read_tokens),
    cache_write_tokens: toInt(u.cache_creation_input_tokens ?? u.cache_write_tokens),
    context_window_size: size !== null && size > 0 ? Math.floor(size) : null,
    context_used_pct: optNum(m.context_used_pct),
    occurred_at: eventTime(m.occurred_at, now),
    utc_offset_min: utcOffset(m.utc_offset_min),
  };
}

/** Quota window lengths: a window cannot reset later than this after it was observed. */
const QUOTA_WINDOW_SEC: Record<string, number> = { five_hour: 5 * 3600, seven_day: 7 * 86400 };
const MAX_WINDOW_SEC = 31 * 86400;
const RESET_SLACK_SEC = 600;

interface RawQuota { limit_type: string; pct: unknown; resets: unknown; windowSec?: number }

/** Windows with a numeric percentage whose reset is not further away than the window is long. */
function keepCurrent(raw: (RawQuota | null)[], measuredAt: number): NormalizedQuota[] {
  const quotas: NormalizedQuota[] = [];
  for (const w of raw) {
    if (!w) continue;
    const pct = Number(w.pct);
    if (w.pct === null || w.pct === undefined || !Number.isFinite(pct) || pct < 0) continue;
    const resets = w.resets !== undefined && w.resets !== null ? toSec(w.resets, null) : null;
    // The window that resets last is shown as current (latestQuotas), so a
    // reset further away than the window is long would pin it: drop it.
    const span = w.windowSec ?? QUOTA_WINDOW_SEC[w.limit_type] ?? MAX_WINDOW_SEC;
    if (resets !== null && resets > measuredAt + span + RESET_SLACK_SEC) continue;
    quotas.push({ limit_type: w.limit_type, used_pct: pct, resets_at: resets });
  }
  return quotas;
}

function contextOf(session: unknown, pct: number | null, size: unknown): NormalizedContext | null {
  const s = str(session);
  const windowSize = optNum(size);
  if (!s || (pct === null && windowSize === null)) return null;
  return { session_id: s, used_pct: pct, window_size: windowSize !== null && windowSize > 0 ? Math.floor(windowSize) : null };
}

const accountRef = (src: Obj) =>
  typeof src.account_ref === "string" && src.account_ref ? src.account_ref : "default";

/**
 * Normalize a Claude Code payload (POST /api/ingest/claude-code).
 *
 * Usage comes from transcript messages, one per Anthropic message id, sent
 * as { messages: [...] } (or one flat event whose event_id is that id). The
 * statusLine re-fires several times per API call with a partial then a final
 * snapshot, so its raw context_window.current_usage is never stored as usage:
 * a raw statusLine payload only contributes quotas and the context gauge.
 * Cost fields and cumulative totals are ignored.
 */
function normalizeClaudeCode(body: unknown): NormalizedBatch {
  const src: Obj = isObj(body) ? body : {};
  const now = nowSec();
  const cw = isObj(src.context_window) ? src.context_window : {};
  const single = !Array.isArray(src.messages);

  const messages: NormalizedMessage[] = [];
  if (!single) {
    for (const m of src.messages as unknown[]) {
      const msg = isObj(m) ? toMessage(m, now) : null;
      if (msg) messages.push(msg);
    }
  } else if (isObj(src.usage)) {
    const msg = toMessage({
      ...src,
      context_window_size: cw.context_window_size ?? src.context_window_size,
      context_used_pct: cw.used_percentage ?? src.context_used_pct,
    }, now);
    if (msg) messages.push(msg);
  }

  const measuredAt = eventTime(src.occurred_at, now);
  const limits: Obj = isObj(src.rate_limits) ? src.rate_limits : {};
  const quotas = keepCurrent(Object.keys(limits).map((key) => {
    const w = limits[key];
    return isObj(w) ? { limit_type: key, pct: w.used_percentage ?? w.used_pct, resets: w.resets_at } : null;
  }), measuredAt);

  // Context gauge: explicit in a batch, or read from a raw statusLine payload.
  const ctx: Obj = isObj(src.context) ? src.context : {};
  const context = contextOf(
    ctx.session_id ?? src.session_id ?? src.sessionId,
    optNum(ctx.used_pct ?? cw.used_percentage),
    ctx.window_size ?? cw.context_window_size,
  );

  return {
    tool: "claude-code",
    messages,
    quotas,
    account_ref: accountRef(src),
    measured_at: measuredAt,
    context,
    single,
  };
}

/**
 * Codex response ids (resp_…) from rollout token_usage_record lines, or, for
 * rollouts written before Codex had them, a token_count line keyed by its
 * session and the thread's cumulative total at that point (tc_<session>_<total>):
 * both are stable across replays, so each response is stored once.
 */
const CODEX_ID = /^(resp_[A-Za-z0-9_-]{1,200}|tc_[A-Za-z0-9-]{1,100}_[0-9]{1,15})$/;

/** Codex quota windows are named by length (rate_limits.primary / secondary). */
const CODEX_WINDOWS: Record<number, string> = { 300: "five_hour", 10080: "seven_day" };

/**
 * One Codex response. OpenAI counts cached input inside input_tokens and
 * reasoning inside output_tokens; stored input excludes the cache (like
 * Anthropic's), so input + output + cache read + cache write is the total once.
 */
function toCodexMessage(m: Obj, now: number): NormalizedMessage | null {
  const id = [m.response_id, m.event_id].find((v) => typeof v === "string" && CODEX_ID.test(v));
  if (typeof id !== "string") return null;
  const u: Obj = isObj(m.usage) ? m.usage : {};
  const cacheRead = toInt(u.cached_input_tokens ?? u.cache_read_input_tokens);
  const cacheWrite = toInt(u.cache_write_input_tokens ?? u.cache_creation_input_tokens);
  return {
    event_id: id,
    session_id: str(m.session_id ?? m.thread_id),
    prompt_id: str(m.turn_id),
    model: modelOf(m.model),
    input_tokens: Math.max(0, toInt(u.input_tokens) - cacheRead - cacheWrite),
    output_tokens: toInt(u.output_tokens),
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    context_window_size: null,
    context_used_pct: null,
    occurred_at: eventTime(m.occurred_at, now),
    utc_offset_min: utcOffset(m.utc_offset_min),
  };
}

/**
 * Normalize a Codex payload (POST /api/ingest/codex): { messages: [...] }
 * read from the rollouts under ~/.codex/sessions, which every Codex front
 * end writes (CLI, exec, IDE extension, desktop app). Rate limits come as
 * Codex reports them (primary / secondary with window_minutes); a cumulative
 * thread total is never stored as usage.
 */
function normalizeCodex(body: unknown): NormalizedBatch {
  const src: Obj = isObj(body) ? body : {};
  const now = nowSec();
  const single = !Array.isArray(src.messages);
  const messages: NormalizedMessage[] = [];
  for (const m of single ? [src] : src.messages as unknown[]) {
    const msg = isObj(m) && isObj(m.usage) ? toCodexMessage(m, now) : null;
    if (msg) messages.push(msg);
  }

  const measuredAt = eventTime(src.occurred_at, now);
  const limits: Obj = isObj(src.rate_limits) ? src.rate_limits : {};
  const quotas = keepCurrent(Object.keys(limits).map((key) => {
    const w = limits[key];
    if (!isObj(w)) return null;
    const minutes = toInt(w.window_minutes);
    // Named already (five_hour, …) or a primary/secondary window of a known length.
    const type = QUOTA_WINDOW_SEC[key] ? key : CODEX_WINDOWS[minutes];
    if (!type) return null;
    return { limit_type: type, pct: w.used_percent ?? w.used_percentage, resets: w.resets_at };
  }), measuredAt);

  // Context fill: Codex reports tokens in the last request and the window size.
  const ctx: Obj = isObj(src.context) ? src.context : {};
  const size = optNum(ctx.window_size);
  const used = optNum(ctx.used_tokens);
  const pct = optNum(ctx.used_pct) ??
    (used !== null && size ? Math.min(100, Math.round((used / size) * 1000) / 10) : null);
  const context = contextOf(ctx.session_id, pct, size);

  return { tool: "codex", messages, quotas, account_ref: accountRef(src), measured_at: measuredAt, context, single };
}

/** OpenCode message ids (msg_…), stored with a prefix: they look like Anthropic ids. */
const OPENCODE_ID = /^msg_[A-Za-z0-9_-]{1,200}$/;

/**
 * One OpenCode assistant message, read from OpenCode's local database.
 * OpenCode 1.18 counts reasoning apart from output (its total adds it), so
 * it is added to output; when a total shows it already inside output (as
 * OpenAI counts it), it is not added twice. Input already excludes the cache.
 */
function toOpenCodeMessage(m: Obj, now: number): NormalizedMessage | null {
  const raw = m.message_id ?? m.event_id;
  if (typeof raw !== "string" || !OPENCODE_ID.test(raw)) return null;
  const u: Obj = isObj(m.usage) ? m.usage : {};
  const input = toInt(u.input_tokens);
  const output = toInt(u.output_tokens);
  const reasoning = toInt(u.reasoning_tokens);
  const cacheRead = toInt(u.cache_read_tokens);
  const cacheWrite = toInt(u.cache_write_tokens);
  const total = optNum(u.total_tokens);
  const inOutput = reasoning > 0 && reasoning <= output && total === input + output + cacheRead + cacheWrite;
  const provider = str(m.provider_id);
  const model = str(m.model_id);
  return {
    event_id: `opencode:${raw}`,
    session_id: str(m.session_id),
    prompt_id: null,
    model: model ? (provider ? `${provider}/${model}` : model) : null,
    input_tokens: input,
    output_tokens: inOutput ? output : output + reasoning,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    context_window_size: null,
    context_used_pct: null,
    occurred_at: eventTime(m.occurred_at, now),
    utc_offset_min: utcOffset(m.utc_offset_min),
  };
}

/**
 * Normalize an OpenCode payload (POST /api/ingest/opencode): { messages: [...] }
 * read from OpenCode's local database (~/.local/share/opencode/opencode.db).
 * OpenCode is multi-provider and has no 5-hour or weekly limit of its own,
 * so no quota is recorded; the model is stored as provider/model.
 */
function normalizeOpenCode(body: unknown): NormalizedBatch {
  const src: Obj = isObj(body) ? body : {};
  const now = nowSec();
  const single = !Array.isArray(src.messages);
  const messages: NormalizedMessage[] = [];
  for (const m of single ? [src] : src.messages as unknown[]) {
    const msg = isObj(m) && isObj(m.usage) ? toOpenCodeMessage(m, now) : null;
    if (msg) messages.push(msg);
  }
  return {
    tool: "opencode", messages, quotas: [], account_ref: accountRef(src),
    measured_at: eventTime(src.occurred_at, now), context: null, single,
  };
}

/**
 * One normalizer per tool slug, picked by the ingest URL
 * (/api/ingest/<slug>). A tool is ingestable once it has an entry here.
 */
/** Antigravity collector sends disjoint input, output (including thinking), and cache counts. */
function normalizeAntigravity(body: unknown): NormalizedBatch {
  const src: Obj = isObj(body) ? body : {};
  const now = nowSec();
  const single = !Array.isArray(src.messages);
  const messages: NormalizedMessage[] = [];
  for (const m of single ? [src] : src.messages as unknown[]) {
    if (!isObj(m) || !isObj(m.usage) || typeof m.response_id !== "string" ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(m.response_id) ||
        typeof m.session_id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(m.session_id)) continue;
    messages.push({
      event_id: `antigravity:${m.session_id}:${m.response_id}`,
      session_id: `antigravity:${m.session_id}`, prompt_id: null, model: modelOf(m.model),
      input_tokens: toInt(m.usage.input_tokens), output_tokens: toInt(m.usage.output_tokens),
      cache_read_tokens: toInt(m.usage.cache_read_tokens), cache_write_tokens: 0,
      context_window_size: null, context_used_pct: null,
      occurred_at: eventTime(m.occurred_at, now), utc_offset_min: utcOffset(m.utc_offset_min),
    });
  }
  return { tool: "antigravity", messages, quotas: [], account_ref: accountRef(src),
    measured_at: eventTime(src.occurred_at, now), context: null, single };
}

const normalizers = new Map<string, (body: unknown) => NormalizedBatch>([
  ["claude-code", normalizeClaudeCode],
  ["codex", normalizeCodex],
  ["opencode", normalizeOpenCode],
  ["antigravity", normalizeAntigravity],
]);

export function normalizerFor(tool: string): ((body: unknown) => NormalizedBatch) | null {
  return normalizers.get(tool) ?? null;
}

/** Empty messages (zero tokens) carry no consumption. */
export function hasConsumption(m: NormalizedMessage): boolean {
  return m.input_tokens > 0 || m.output_tokens > 0 ||
    m.cache_read_tokens > 0 || m.cache_write_tokens > 0;
}
