// API-equivalent value: what measured tokens would cost at the providers'
// published retail API rates (USD). An estimate of value, not what anyone
// paid: subscriptions, discounts, invoices and the providers' own serving
// costs are out of scope (issue #113). Used by the server (profiles,
// leaderboard) and the /demo dataset, so every page prices tokens the same way.
//
// Rules:
// - Only official, published rates, each with its source and the date it
//   took effect. A model without one is "unpriced": its tokens are counted
//   in `unpriced_tokens`, never valued at $0 or guessed from a similar model.
// - Usage is priced at the rate in effect on its (UTC) day. Usage older than
//   the oldest known rate of its model is priced at that rate and flagged
//   (`current_rate_fallback`): the earlier rate was not published.
// - Conditions the measured data cannot tell apart are priced at the lower
//   documented rate and flagged (`lower_bound`), e.g. Anthropic cache writes
//   recorded before their 5-minute / 1-hour split was collected.

/** Bump with every change to the rates below (shown next to the values). */
export const PRICING_VERSION = "2026-10-03";
export const PRICING_CURRENCY = "USD";

/** Tools whose usage is priced so far; the others count as unpriced. */
export const PRICED_TOOLS = ["claude-code", "codex"] as const;

type Provider = "anthropic" | "openai";
const TOOL_PROVIDER: Record<string, Provider> = { "claude-code": "anthropic", codex: "openai" };

/** USD per million tokens. */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  /** Anthropic 5-minute cache write; OpenAI cache write (input rate where none is listed). */
  cacheWrite: number;
  /** Anthropic 1-hour cache write; absent for OpenAI (one write rate). */
  cacheWrite1h?: number;
}

/** The rates of one processing tier, and above the long-context threshold when they differ. */
interface TierRates {
  rates: Rates;
  /** Prompts above `longContextAbove`; null: such requests have no published rate (unpriced). */
  long?: Rates | null;
}

export interface PriceEntry {
  provider: Provider;
  /** Model ids as the tools record them (date/snapshot suffixes stripped, lowercase). */
  models: string[];
  /** First UTC day these rates apply (YYYY-MM-DD); absent: since the model's release. */
  from?: string;
  standard: TierRates;
  /** Prompt size (input + cache read + cache write) above which `long` rates apply to the whole request. */
  longContextAbove?: number;
  fast?: TierRates;
  flex?: TierRates;
  ultrafast?: TierRates;
  /** Anthropic `inference_geo: "us"` (Claude 4.6 and later): every rate × this. */
  usMultiplier?: number;
  source: string;
}

const ANTHROPIC_PRICING = "https://platform.claude.com/docs/en/about-claude/pricing";
const ANTHROPIC_LEGACY_PRICING = "https://docs.anthropic.com/en/docs/about-claude/pricing";
const OPENAI_PRICING = "https://developers.openai.com/api/docs/pricing";
const openaiModel = (id: string) => `https://developers.openai.com/api/docs/models/${id}`;

/**
 * Anthropic rates from base input/output: 5-minute writes 1.25×, 1-hour
 * writes 2×, reads `read`× the input rate (documented multipliers; they
 * stack on fast mode, long context and data residency).
 */
function claude(input: number, output: number, read = 0.1): Rates {
  return { input, output, cacheRead: input * read, cacheWrite: input * 1.25, cacheWrite1h: input * 2 };
}

/** OpenAI rates; `write` defaults to the input rate (no cache-write fee listed: writes are input). */
function gpt(input: number, cached: number, output: number, write = input): Rates {
  return { input, output, cacheRead: cached, cacheWrite: write };
}

/** OpenAI Flex is billed at Batch rates: half of Standard, long context included. */
const half = (r: Rates): Rates => ({ input: r.input / 2, output: r.output / 2, cacheRead: r.cacheRead / 2, cacheWrite: r.cacheWrite / 2 });
const flexOf = (t: TierRates): TierRates => ({ rates: half(t.rates), long: t.long ? half(t.long) : t.long });

// Claude 4.6 and later: the whole 1M context at standard rates, US-only
// inference 1.1×. Sonnet 4 and 4.5 charged 2× input and 1.5× output for a
// whole request above 200K prompt tokens (1M context beta).
const sonnet4Long = { rates: claude(3, 15), long: claude(6, 22.5) };

export const PRICES: PriceEntry[] = [
  { provider: "anthropic", models: ["claude-fable-5-1", "claude-mythos-5-1"], standard: { rates: claude(10, 50, 0.025) }, usMultiplier: 1.1, source: ANTHROPIC_PRICING },
  { provider: "anthropic", models: ["claude-fable-5", "claude-mythos-5"], standard: { rates: claude(10, 50) }, usMultiplier: 1.1, source: ANTHROPIC_PRICING },
  {
    provider: "anthropic", models: ["claude-opus-5-5"], standard: { rates: claude(4, 20, 0.05) },
    fast: { rates: claude(8, 40, 0.05) }, usMultiplier: 1.1, source: ANTHROPIC_PRICING,
  },
  {
    provider: "anthropic", models: ["claude-opus-5", "claude-opus-4-8"], standard: { rates: claude(5, 25) },
    fast: { rates: claude(10, 50) }, usMultiplier: 1.1, source: ANTHROPIC_PRICING,
  },
  { provider: "anthropic", models: ["claude-opus-4-7", "claude-opus-4-6"], standard: { rates: claude(5, 25) }, usMultiplier: 1.1, source: ANTHROPIC_PRICING },
  { provider: "anthropic", models: ["claude-opus-4-5"], standard: { rates: claude(5, 25) }, source: ANTHROPIC_PRICING },
  { provider: "anthropic", models: ["claude-opus-4-1", "claude-opus-4"], standard: { rates: claude(15, 75) }, source: ANTHROPIC_PRICING },
  { provider: "anthropic", models: ["claude-sonnet-5-5", "claude-sonnet-5"], standard: { rates: claude(2, 10) }, usMultiplier: 1.1, source: ANTHROPIC_PRICING },
  { provider: "anthropic", models: ["claude-sonnet-4-6"], standard: { rates: claude(3, 15) }, usMultiplier: 1.1, source: ANTHROPIC_PRICING },
  { provider: "anthropic", models: ["claude-sonnet-4-5", "claude-sonnet-4"], standard: sonnet4Long, longContextAbove: 200_000, source: ANTHROPIC_PRICING },
  { provider: "anthropic", models: ["claude-haiku-4-5"], standard: { rates: claude(1, 5) }, source: ANTHROPIC_PRICING },
  { provider: "anthropic", models: ["claude-3-5-haiku"], standard: { rates: claude(0.8, 4) }, source: ANTHROPIC_PRICING },
  { provider: "anthropic", models: ["claude-3-7-sonnet", "claude-3-5-sonnet"], standard: { rates: claude(3, 15) }, source: ANTHROPIC_LEGACY_PRICING },

  // OpenAI, Standard tier. "Long" is a prompt above 272K tokens, priced as a whole.
  ...gpt6(),
  { provider: "openai", models: ["gpt-5.5"], longContextAbove: 272_000,
    standard: { rates: gpt(5, 0.5, 30), long: gpt(10, 1, 45) },
    fast: { rates: gpt(12.5, 1.25, 75), long: null },
    flex: { rates: gpt(2.5, 0.25, 15), long: gpt(5, 0.5, 22.5) },
    source: openaiModel("gpt-5.5") },
  { provider: "openai", models: ["gpt-5.4"], longContextAbove: 272_000,
    standard: { rates: gpt(2.5, 0.25, 15), long: gpt(5, 0.5, 22.5) },
    fast: { rates: gpt(5, 0.5, 30), long: null },
    flex: flexOf({ rates: gpt(2.5, 0.25, 15), long: gpt(5, 0.5, 22.5) }),
    source: openaiModel("gpt-5.4") },
  { provider: "openai", models: ["gpt-5.4-mini"], standard: { rates: gpt(0.75, 0.075, 4.5) },
    fast: { rates: gpt(1.5, 0.15, 9) }, flex: flexOf({ rates: gpt(0.75, 0.075, 4.5) }), source: OPENAI_PRICING },
  { provider: "openai", models: ["gpt-5.4-nano"], standard: { rates: gpt(0.2, 0.02, 1.25) },
    flex: flexOf({ rates: gpt(0.2, 0.02, 1.25) }), source: OPENAI_PRICING },
  { provider: "openai", models: ["gpt-5.3-codex"], standard: { rates: gpt(1.75, 0.175, 14) },
    fast: { rates: gpt(3.5, 0.35, 28) }, source: OPENAI_PRICING },
  { provider: "openai", models: ["gpt-5.2"], standard: { rates: gpt(1.75, 0.175, 14) },
    fast: { rates: gpt(3.5, 0.35, 28) }, flex: flexOf({ rates: gpt(1.75, 0.175, 14) }), source: OPENAI_PRICING },
  { provider: "openai", models: ["gpt-5.2-codex"], standard: { rates: gpt(1.75, 0.175, 14) }, source: openaiModel("gpt-5.2-codex") },
  { provider: "openai", models: ["gpt-5.1", "gpt-5"], standard: { rates: gpt(1.25, 0.125, 10) },
    fast: { rates: gpt(2.5, 0.25, 20) }, flex: flexOf({ rates: gpt(1.25, 0.125, 10) }), source: OPENAI_PRICING },
  { provider: "openai", models: ["gpt-5.1-codex", "gpt-5.1-codex-max", "gpt-5-codex"], standard: { rates: gpt(1.25, 0.125, 10) }, source: openaiModel("gpt-5-codex") },
  { provider: "openai", models: ["gpt-5.1-codex-mini"], standard: { rates: gpt(0.25, 0.025, 2) }, source: openaiModel("gpt-5.1-codex-mini") },
  { provider: "openai", models: ["gpt-5-mini"], standard: { rates: gpt(0.25, 0.025, 2) },
    fast: { rates: gpt(0.45, 0.045, 3.6) }, flex: flexOf({ rates: gpt(0.25, 0.025, 2) }), source: OPENAI_PRICING },
  { provider: "openai", models: ["gpt-5-nano"], standard: { rates: gpt(0.05, 0.005, 0.4) },
    flex: flexOf({ rates: gpt(0.05, 0.005, 0.4) }), source: OPENAI_PRICING },
  { provider: "openai", models: ["codex-mini-latest"], standard: { rates: gpt(1.5, 0.375, 6) }, source: openaiModel("codex-mini-latest") },
  { provider: "openai", models: ["o3"], standard: { rates: gpt(2, 0.5, 8) },
    fast: { rates: gpt(3.5, 0.875, 14) }, flex: flexOf({ rates: gpt(2, 0.5, 8) }), source: OPENAI_PRICING },
  { provider: "openai", models: ["o4-mini"], standard: { rates: gpt(1.1, 0.275, 4.4) },
    fast: { rates: gpt(2, 0.5, 8) }, flex: flexOf({ rates: gpt(1.1, 0.275, 4.4) }), source: OPENAI_PRICING },
  { provider: "openai", models: ["gpt-4.1"], standard: { rates: gpt(2, 0.5, 8) },
    fast: { rates: gpt(3.5, 0.875, 14) }, source: OPENAI_PRICING },
];

/**
 * GPT-6 and GPT-5.6: cache writes 1.25× input, long context 2× input and
 * cache, 1.5× output for the whole request; Fast 2× Standard (long context
 * included), Flex half. GPT-5.6 Sol's current rates apply from Aug 21 2026,
 * Luna's and Terra's from Jul 30 2026; their earlier rates are not published.
 */
function gpt6(): PriceEntry[] {
  const family = (models: string[], input: number, cached: number, output: number, from?: string): PriceEntry => {
    const rates = gpt(input, cached, output, input * 1.25);
    const long = gpt(input * 2, cached * 2, output * 1.5, input * 2.5);
    const double = (r: Rates): Rates => ({ input: r.input * 2, output: r.output * 2, cacheRead: r.cacheRead * 2, cacheWrite: r.cacheWrite * 2 });
    const standard = { rates, long };
    return {
      provider: "openai", models, from, longContextAbove: 272_000, standard,
      fast: { rates: double(rates), long: double(long) }, flex: flexOf(standard),
      source: openaiModel(models[0]),
    };
  };
  const astra = family(["gpt-6-astra"], 10, 1, 50);
  astra.ultrafast = { rates: gpt(60, 6, 300, 75), long: gpt(120, 12, 450, 150) };
  return [
    astra,
    family(["gpt-6.1-sol"], 2, 0.1, 10),
    family(["gpt-6-sol"], 2, 0.2, 10),
    family(["gpt-6-luna"], 0.1, 0.01, 0.5),
    family(["gpt-5.6-sol", "gpt-5.6"], 4, 0.4, 20, "2026-08-21"),
    family(["gpt-5.6-terra"], 2, 0.2, 12, "2026-07-30"),
    family(["gpt-5.6-luna"], 0.2, 0.02, 1.2, "2026-07-30"),
  ];
}

/**
 * The model id a price is looked up by: lowercase, without a date suffix
 * (claude-sonnet-4-5-20250929, gpt-5.4-2026-03-05). Anything else (another
 * provider's prefix, a cloud platform id) does not match and stays unpriced.
 */
export function priceModelId(model: string): string {
  return model.trim().toLowerCase().replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

const dayOf = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

/**
 * Days (UTC) where some model's rates change. Usage is grouped by the
 * period between them, so each group falls under one rate per model.
 */
export const PRICE_BOUNDARIES: number[] = [...new Set(PRICES.flatMap((p) => (p.from ? [p.from] : [])))]
  .sort().map((d) => Date.parse(d + "T00:00:00Z") / 1000);

/** Prompt sizes above which some model has long-context rates, ascending. */
export const LONG_CONTEXT_THRESHOLDS: number[] = [...new Set(PRICES.flatMap((p) => (p.longContextAbove ? [p.longContextAbove] : [])))]
  .sort((a, b) => a - b);

/** The period index of a time (0 before the first boundary). */
export const periodOf = (sec: number) => PRICE_BOUNDARIES.filter((b) => sec >= b).length;

/** The context band of a prompt: how many thresholds it exceeds. */
export const contextBandOf = (promptTokens: number) => LONG_CONTEXT_THRESHOLDS.filter((t) => promptTokens > t).length;

/** Measured usage sharing every input of its price (one tool, model, tier, region, context band and period). */
export interface PriceGroup {
  tool: string;
  model: string | null;
  service_tier: string | null;
  inference_geo: string | null;
  /** contextBandOf(prompt): the highest threshold its requests exceeded. */
  band: number;
  /** periodOf(occurred_at). */
  period: number;
  input: number;
  output: number;
  cache_read: number;
  /** Every cache write, whatever its duration. */
  cache_write: number;
  /** Of those, written to Anthropic's 1-hour cache. */
  cache_write_1h: number;
  /** Of those, without a recorded 5-minute / 1-hour split. */
  cache_write_unsplit: number;
}

export interface ApiValue {
  /** USD at retail API rates of the priced tokens; null when none could be priced. */
  usd: number | null;
  priced_tokens: number;
  /** Tokens left out: a tool not priced yet, or a model, tier or region without a published rate. */
  unpriced_tokens: number;
  /** Some cache writes had no recorded duration and were priced at the cheaper 5-minute rate. */
  lower_bound: boolean;
  /** Some usage predates its model's oldest published rate and was priced at that rate. */
  current_rate_fallback: boolean;
}

export const emptyValue = (): ApiValue => ({
  usd: null, priced_tokens: 0, unpriced_tokens: 0, lower_bound: false, current_rate_fallback: false,
});

const groupTokens = (g: PriceGroup) => g.input + g.output + g.cache_read + g.cache_write;

/** The entry pricing a model on a day, and whether it is a fallback (usage before its oldest rate). */
function entryFor(provider: Provider, model: string, period: number): { entry: PriceEntry; fallback: boolean } | null {
  const id = priceModelId(model);
  const all = PRICES.filter((p) => p.provider === provider && p.models.includes(id));
  if (!all.length) return null;
  // The period starts at PRICE_BOUNDARIES[period - 1] (or the beginning of time).
  const start = period > 0 ? dayOf(PRICE_BOUNDARIES[period - 1]) : "";
  const applicable = all.filter((p) => !p.from || p.from <= start).sort((a, b) => ((a.from ?? "") < (b.from ?? "") ? 1 : -1));
  if (applicable.length) return { entry: applicable[0], fallback: false };
  const oldest = [...all].sort((a, b) => ((a.from ?? "") < (b.from ?? "") ? -1 : 1))[0];
  return { entry: oldest, fallback: true };
}

/** The tier a recorded service tier is priced at, or null when it has no retail equivalent here. */
function tierOf(provider: Provider, tier: string | null): "standard" | "fast" | "flex" | "ultrafast" | null {
  const t = (tier ?? "").toLowerCase();
  if (provider === "anthropic") {
    // Claude Code records "standard" (subscription and API alike); fast mode as speed "fast".
    if (t === "" || t === "standard") return "standard";
    return t === "fast" ? "fast" : null;
  }
  if (t === "" || t === "default" || t === "auto" || t === "standard") return "standard";
  // Codex's Fast mode is OpenAI's priority tier (renamed Fast on Jul 30 2026).
  if (t === "fast" || t === "priority") return "fast";
  return t === "flex" || t === "ultrafast" ? t : null;
}

/** USD of one group, or null when it cannot be priced from published rates. */
export function priceGroup(g: PriceGroup): { usd: number; lowerBound: boolean; fallback: boolean } | null {
  const provider = TOOL_PROVIDER[g.tool];
  if (!provider || !g.model) return null;
  const found = entryFor(provider, g.model, g.period);
  if (!found) return null;
  const { entry, fallback } = found;
  const tierName = tierOf(provider, g.service_tier);
  const tier = tierName ? entry[tierName] : undefined;
  if (!tier) return null;
  const long = entry.longContextAbove !== undefined && LONG_CONTEXT_THRESHOLDS
    .slice(0, g.band).some((t) => t >= entry.longContextAbove!);
  const rates = long ? tier.long === undefined ? tier.rates : tier.long : tier.rates;
  if (!rates) return null;
  const geo = (g.inference_geo ?? "").toLowerCase();
  let region = 1;
  if (geo === "us" && entry.usMultiplier) region = entry.usMultiplier;
  else if (geo === "us" || !["", "global", "not_available"].includes(geo)) return null;
  const write5m = g.cache_write - g.cache_write_1h;
  const usd = (g.input * rates.input + g.output * rates.output + g.cache_read * rates.cacheRead +
    write5m * rates.cacheWrite + g.cache_write_1h * (rates.cacheWrite1h ?? rates.cacheWrite)) / 1e6 * region;
  // Unsplit Anthropic writes were priced at the 5-minute rate: maybe 1-hour ones.
  const lowerBound = g.cache_write_unsplit > 0 && rates.cacheWrite1h !== undefined && rates.cacheWrite1h > rates.cacheWrite;
  return { usd, lowerBound, fallback };
}

/** Adds a group into a running value (mutates and returns `v`). */
export function addGroup(v: ApiValue, g: PriceGroup): ApiValue {
  const tokens = groupTokens(g);
  const p = priceGroup(g);
  if (!p) {
    v.unpriced_tokens += tokens;
    return v;
  }
  v.usd = (v.usd ?? 0) + p.usd;
  v.priced_tokens += tokens;
  v.lower_bound ||= p.lowerBound;
  v.current_rate_fallback ||= p.fallback;
  return v;
}

/** The value of several groups. */
export const valueOf = (groups: Iterable<PriceGroup>): ApiValue => {
  const v = emptyValue();
  for (const g of groups) addGroup(v, g);
  return v;
};
