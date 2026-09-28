/** Versioned, conservative retail API token valuation. USD per million tokens. */
export const PRICE_VERSION = "2026-09-28";
export const PRICE_NOTE = "Standard first-party text API rates in USD, checked 2026-09-28. Current rates are applied to older usage when historical rates are unavailable. Excludes tools, grounding, cache storage, batch/priority, regional and subscription charges. Events needing an unknown tier or cache-write duration are unpriced.";

type Rates = { input: number; output: number; read: number; write?: number; long?: [number, number, number, number] };
const CLAUDE = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI = "https://developers.openai.com/api/docs/pricing";
const GEMINI = "https://ai.google.dev/gemini-api/docs/pricing";
// These are the first dates we verified these published rates, not claimed
// launch dates. Until a dated earlier rate is documented, older usage is a
// visible current-rate fallback.
const VERIFIED_ON = "2026-09-28";
const CATALOG: Record<string, { verifiedOn: string; source: string; rates: Rates }> = {
  "claude-opus-5-5": { verifiedOn: VERIFIED_ON, source: CLAUDE, rates: { input: 4, output: 20, read: .20 } },
  "claude-sonnet-5": { verifiedOn: VERIFIED_ON, source: CLAUDE, rates: { input: 2, output: 10, read: .20 } },
  "claude-sonnet-4-5": { verifiedOn: VERIFIED_ON, source: CLAUDE, rates: { input: 3, output: 15, read: .30 } },
  "claude-haiku-4-5": { verifiedOn: VERIFIED_ON, source: CLAUDE, rates: { input: 1, output: 5, read: .10 } },
  "gpt-5-codex": { verifiedOn: VERIFIED_ON, source: "https://developers.openai.com/api/docs/models/gpt-5-codex", rates: { input: 1.25, output: 10, read: .125 } },
  "gpt-6-astra": { verifiedOn: VERIFIED_ON, source: OPENAI, rates: { input: 10, output: 50, read: 1, write: 12.5, long: [20, 75, 2, 25] } },
  "gpt-6-sol": { verifiedOn: VERIFIED_ON, source: OPENAI, rates: { input: 2, output: 10, read: .2, write: 2.5, long: [4, 15, .4, 5] } },
  "gpt-6-luna": { verifiedOn: VERIFIED_ON, source: OPENAI, rates: { input: .1, output: .5, read: .01, write: .125, long: [.2, .75, .02, .25] } },
  "gemini-3.5-flash": { verifiedOn: VERIFIED_ON, source: GEMINI, rates: { input: 1.5, output: 9, read: .15 } },
  "gemini-2.5-flash": { verifiedOn: VERIFIED_ON, source: GEMINI, rates: { input: .3, output: 2.5, read: .03 } },
};

export interface ValueEvent {
  tool: string; model: string | null; input_tokens: number; output_tokens: number;
  cache_read_tokens: number; cache_write_tokens: number; source: string; occurred_at: number; received_at: number;
}
export type ValueReason = "unknown_model" | "insufficient_detail" | "snapshot";
export function priceEvent(e: ValueEvent): { usd: number; source: string; fallback: boolean } | { reason: ValueReason } {
  if (e.source !== "message") return { reason: "snapshot" };
  const model = e.model?.toLowerCase() ?? "";
  const [provider, name] = model.includes("/") ? model.split("/", 2) : ["", model];
  const rate = CATALOG[name];
  const expectedProvider = name.startsWith("claude-") ? "anthropic" : name.startsWith("gpt-") ? "openai" : "google";
  if (!rate || (provider && provider !== expectedProvider)) return { reason: "unknown_model" };
  const fallback = e.occurred_at < Date.parse(rate.verifiedOn + "T00:00:00Z") / 1000;
  const r = rate.rates;
  if (e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_write_tokens <= 0) return { reason: "insufficient_detail" };
  if (name.startsWith("claude-") && (e.cache_write_tokens > 0 || e.input_tokens + e.cache_read_tokens > 200_000)) return { reason: "insufficient_detail" };
  if (e.cache_write_tokens > 0 && r.write === undefined) return { reason: "insufficient_detail" };
  const [input, output, read, write] = r.long && e.input_tokens + e.cache_read_tokens + e.cache_write_tokens > 272_000
    ? r.long : [r.input, r.output, r.read, r.write ?? 0];
  return { usd: (e.input_tokens * input + e.output_tokens * output + e.cache_read_tokens * read + e.cache_write_tokens * write) / 1_000_000, source: rate.source, fallback };
}

export const priceSources = [...new Set(Object.values(CATALOG).map((x) => x.source))];
