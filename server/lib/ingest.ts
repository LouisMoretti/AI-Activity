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

function modelOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  return isObj(v) ? str(v.id || v.display_name || null) : null;
}

/**
 * One message, or null without a message id: a usage snapshot that cannot
 * be tied to one API response would be counted again on every re-fire.
 */
function toMessage(m: Obj, now: number): NormalizedMessage | null {
  const id = [m.message_id, m.event_id, m.eventId].find((v) => typeof v === "string" && v);
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
  };
}

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

  const limits: Obj = isObj(src.rate_limits) ? src.rate_limits : {};
  const quotas: NormalizedQuota[] = [];
  for (const key of Object.keys(limits)) {
    const w = limits[key];
    if (!isObj(w)) continue;
    const pct = Number(w.used_percentage ?? w.used_pct);
    if (!Number.isFinite(pct) || pct < 0) continue;
    quotas.push({
      limit_type: key,
      used_pct: pct,
      resets_at: w.resets_at !== undefined && w.resets_at !== null ? toSec(w.resets_at, null) : null,
    });
  }

  // Context gauge: explicit in a batch, or read from a raw statusLine payload.
  const ctx: Obj = isObj(src.context) ? src.context : {};
  const ctxSession = str(ctx.session_id ?? src.session_id ?? src.sessionId);
  const ctxPct = optNum(ctx.used_pct ?? cw.used_percentage);
  const ctxSize = optNum(ctx.window_size ?? cw.context_window_size);
  const context = ctxSession && (ctxPct !== null || ctxSize !== null)
    ? { session_id: ctxSession, used_pct: ctxPct, window_size: ctxSize !== null && ctxSize > 0 ? Math.floor(ctxSize) : null }
    : null;

  return {
    tool: "claude-code",
    messages,
    quotas,
    account_ref: typeof src.account_ref === "string" && src.account_ref ? src.account_ref : "default",
    measured_at: eventTime(src.occurred_at, now),
    context,
    single,
  };
}

/**
 * One normalizer per tool slug, picked by the ingest URL
 * (/api/ingest/<slug>). A tool is ingestable once it has an entry here.
 */
const normalizers = new Map<string, (body: unknown) => NormalizedBatch>([
  ["claude-code", normalizeClaudeCode],
]);

export function normalizerFor(tool: string): ((body: unknown) => NormalizedBatch) | null {
  return normalizers.get(tool) ?? null;
}

/** Empty messages (zero tokens) carry no consumption. */
export function hasConsumption(m: NormalizedMessage): boolean {
  return m.input_tokens > 0 || m.output_tokens > 0 ||
    m.cache_read_tokens > 0 || m.cache_write_tokens > 0;
}
