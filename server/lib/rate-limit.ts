import type { Context, MiddlewareHandler } from "hono";

/**
 * Limits, sized so normal use never meets them (AGENTS.md §5, §6):
 * - ingest, per device key and tool (one key serves every tool on a
 *   machine; a Claude Code import must not hold up Codex):
 *   - requests that write rows or only carry quotas / context;
 *   - replays: batches whose messages were all stored already. Collectors
 *     resend their whole backlog after any refusal (the Claude Code one
 *     only saves its offsets once a run is fully accepted), so replays get
 *     their own, much larger budget and pass even while rows are limited;
 *   - rows written (stored or updated). The burst covers a first import of
 *     a month of history; past it, a batch that would write is rolled back
 *     (its quotas and context are still kept) until the budget refills;
 * - public reads, per client: a dashboard polls 7 routes every 15 s
 *   (28/min); 300 with 5/s leaves room for about ten tabs behind one
 *   address;
 * - signed-in routes (devices, account, users, admin), per user.
 */
export const LIMITS = {
  ingestRequests: { capacity: 300, perSec: 5 },
  ingestReplays: { capacity: 3000, perSec: 50 },
  ingestWrites: { capacity: 20_000, perSec: 10 },
  publicReads: { capacity: 300, perSec: 5 },
  sessionRequests: { capacity: 120, perSec: 1 },
  /** Live (not revoked) devices per account, from Settings; the CLI is not capped. */
  devicesPerAccount: 20,
};

/**
 * Token buckets, one per key (device, client, user): `capacity` tokens,
 * refilled at `perSec`. In memory, so they reset when the server restarts
 * (one process; acceptable, see AGENTS.md §6). Idle buckets are forgotten
 * once full again, so the map only holds recently active keys.
 */
export function tokenBuckets({ capacity, perSec }: { capacity: number; perSec: number }, now = () => Date.now()) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  let swept = now();

  const level = (key: string) => {
    const t = now();
    if (t - swept > 60_000) {
      for (const [k, b] of buckets) if (b.tokens + ((t - b.at) / 1000) * perSec >= capacity) buckets.delete(k);
      swept = t;
    }
    const b = buckets.get(key) ?? { tokens: capacity, at: t };
    b.tokens = Math.min(capacity, b.tokens + ((t - b.at) / 1000) * perSec);
    b.at = t;
    buckets.set(key, b);
    return b;
  };

  return {
    /** Seconds until one token is available: 0 when there is one now. */
    wait(key: string): number {
      const b = level(key);
      return b.tokens >= 1 ? 0 : Math.ceil((1 - b.tokens) / perSec);
    },
    /**
     * Takes `n` tokens. The level may go below zero: a batch is charged what
     * it actually wrote, and the debt delays the next request.
     */
    take(key: string, n = 1): void {
      level(key).tokens -= n;
    },
  };
}

export type TokenBuckets = ReturnType<typeof tokenBuckets>;

/** `429` with `Retry-After` (seconds). */
export const tooManyRequests = (c: Context, wait: number) => {
  c.header("retry-after", String(Math.max(1, wait)));
  return c.json({ error: "too many requests, slow down" }, 429);
};

/** One token per request, per `keyOf(c)`; over the limit → `429`, the handler never runs. */
export function rateLimit(buckets: TokenBuckets, keyOf: (c: Context) => string): MiddlewareHandler {
  return async (c, next) => {
    const key = keyOf(c);
    const wait = buckets.wait(key);
    if (wait) return tooManyRequests(c, wait);
    buckets.take(key);
    await next();
  };
}
