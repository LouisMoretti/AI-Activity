import { randomUUID } from "node:crypto";
import { nowSec } from "../db/schema.ts";

export interface NormalizedQuota {
  limit_type: string;
  used_pct: number;
  resets_at: number | null;
}

export interface NormalizedEvent {
  event_id: string;
  event_id_generated: boolean;
  tool: string;
  session_id: string | null;
  prompt_id: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_estimated_usd: number | null;
  context_window_size: number | null;
  context_used_pct: number | null;
  occurred_at: number;
  account_ref: string;
  quotas: NormalizedQuota[];
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
export function normalizeIngest(body: unknown): NormalizedEvent {
  const src: Obj = isObj(body) ? body : {};
  const now = nowSec();

  const cw = isObj(src.context_window) ? src.context_window : {};
  const u: Obj = (isObj(src.usage) && src.usage) ||
    (isObj(cw.current_usage) && cw.current_usage) || {};

  let model: string | null = null;
  if (typeof src.model === "string") model = src.model;
  else if (isObj(src.model)) {
    model = str(src.model.id || src.model.display_name || null);
  }

  let tool = typeof src.tool === "string" ? src.tool : "claude-code";
  if (tool === "claude") tool = "claude-code";

  // Estimated cost: ONLY an explicit delta is accepted. The statusLine
  // cost.total_cost_usd field is cumulative per session and must never
  // be summed, so it is ignored here by design.
  const delta = src.cost_estimated_usd_delta ?? src.cost_estimated_usd ?? null;
  const costDelta = delta === null ? null : Number(delta);
  const costOk = costDelta !== null && Number.isFinite(costDelta) && costDelta >= 0;

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
      resets_at: w.resets_at !== undefined && w.resets_at !== null
        ? toSec(w.resets_at, null)
        : null,
    });
  }

  // Context fill of the conversation at this call (a gauge, not summed).
  const ctxSize = optNum(cw.context_window_size ?? src.context_window_size);
  const ctxPct = optNum(cw.used_percentage ?? src.context_used_pct);

  const providedId =
    (typeof src.event_id === "string" && src.event_id) ||
    (typeof src.eventId === "string" && src.eventId) || null;

  return {
    event_id: providedId || randomUUID(),
    event_id_generated: !providedId,
    tool,
    session_id: str(src.session_id ?? src.sessionId),
    prompt_id: str(src.prompt_id ?? src.promptId),
    model,
    input_tokens: toInt(u.input_tokens),
    output_tokens: toInt(u.output_tokens),
    cache_read_tokens: toInt(u.cache_read_input_tokens ?? u.cache_read_tokens),
    cache_write_tokens: toInt(u.cache_creation_input_tokens ?? u.cache_write_tokens),
    cost_estimated_usd: costOk ? costDelta : null,
    context_window_size: ctxSize !== null && ctxSize > 0 ? Math.floor(ctxSize) : null,
    context_used_pct: ctxPct,
    // A skewed device clock must not put usage in the future (heatmap,
    // streaks, "today"); spooled events keep their older time.
    occurred_at: src.occurred_at !== undefined ? Math.min(toSec(src.occurred_at, now), now) : now,
    account_ref: typeof src.account_ref === "string" && src.account_ref
      ? src.account_ref
      : "default",
    quotas,
  };
}

/** Empty snapshots (session start, zero tokens, no cost delta) carry no consumption. */
export function hasConsumption(ev: NormalizedEvent): boolean {
  return ev.input_tokens > 0 || ev.output_tokens > 0 ||
    ev.cache_read_tokens > 0 || ev.cache_write_tokens > 0 ||
    ev.cost_estimated_usd !== null;
}
