// API-equivalent value: what measured tokens would cost at retail API rates
// (USD). An estimate of value, not what anyone paid: subscriptions,
// discounts, invoices and the providers' own serving costs are out of
// scope (issues #113, #268). Used by the server (profiles, leaderboard,
// admin panel) and the /demo dataset, so every page prices tokens alike.
//
// Where a rate comes from, first match wins:
// 1. shared/pricing.json, the priority file: `aliases` price a model as
//    another one (OpenCode's free Muse Spark at Meta's paid rate), `prices`
//    are verified official rates, each with its source and the day it took
//    effect. Edit that file, not this one, to add a model.
// 2. A fallback catalog the server loads (LiteLLM's community price list,
//    server/lib/litellm.ts): usage priced from it is flagged `unverified`.
// 3. Nothing: the tokens count as `unpriced_tokens`, never as $0, and the
//    admin panel lists the model with the reason.
//
// Rules:
// - Usage is priced at the rate in effect on its (UTC) day. Usage older than
//   the oldest known rate of its model is priced at that rate and flagged
//   (`current_rate_fallback`): the earlier rate was not published.
// - Conditions the measured data cannot tell apart are priced at the lower
//   documented rate and flagged (`lower_bound`), e.g. Anthropic cache writes
//   recorded before their 5-minute / 1-hour split was collected.
// - A token category with tokens but no rate leaves the whole group unpriced:
//   no rate is ever guessed from another one.
import PRICING_FILE from "./pricing.json" with { type: "json" };

/** USD per million tokens. A missing cache rate: none published (see explainPrice). */
export interface Rates {
  input: number;
  output: number;
  cacheRead?: number;
  /** Anthropic 5-minute cache write; OpenAI cache write (input rate where none is listed). */
  cacheWrite?: number;
  /** Anthropic 1-hour cache write; absent: one write rate. */
  cacheWrite1h?: number;
}

/** The rates of one processing tier, and above the long-context threshold when they differ. */
export interface TierRates {
  rates: Rates;
  /** Prompts above `longContextAbove`; null: such requests have no published rate (unpriced). */
  long?: Rates | null;
}

export interface PriceEntry {
  /** Who sells at these rates (anthropic, openai, meta, …): the `provider/` of a stored model. */
  provider: string;
  /** Model ids (date/snapshot suffixes stripped, lowercase). */
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
  /** Official page of these rates (priority file), or where a fallback catalog took them. */
  source: string;
}

/** A model priced as another one ("provider/model" ids, as stored). */
export interface PriceAlias {
  model: string;
  price_as: string;
  /** Why, for whoever reads the file. */
  note: string;
}

export interface PricingFile {
  version: string;
  currency: "USD";
  aliases: PriceAlias[];
  prices: PriceEntry[];
}

/** Rates beyond this (USD per million tokens) are taken for a typo. */
const MAX_RATE = 10_000;
const OFFICIAL_SOURCE = /^https:\/\/(platform\.claude\.com|docs\.anthropic\.com|developers\.openai\.com)\//;
const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function checkRates(r: unknown, where: string): void {
  if (!isObj(r)) throw new Error(`${where}: rates must be an object`);
  for (const [k, v] of Object.entries(r)) {
    if (!RATE_KEYS.includes(k)) throw new Error(`${where}: unknown rate ${k}`);
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_RATE) {
      throw new Error(`${where}: ${k} must be a rate in USD per million tokens`);
    }
  }
  if (r.input === undefined || r.output === undefined) throw new Error(`${where}: input and output rates are required`);
}

function checkTier(t: unknown, where: string, hasLong: boolean): void {
  if (!isObj(t)) throw new Error(`${where} must be an object`);
  checkRates(t.rates, `${where}.rates`);
  if (t.long !== undefined && t.long !== null) checkRates(t.long, `${where}.long`);
  if (t.long !== undefined && !hasLong) throw new Error(`${where}.long needs longContextAbove`);
}

/**
 * The priority file, checked: rates are numbers in range, every price has an
 * official source, every model id is stored as it is looked up and priced
 * once per effective day, and aliases point to another model. Throws on the
 * first problem, so a bad edit fails the tests and the server's start.
 */
export function parsePricingFile(raw: unknown): PricingFile {
  if (!isObj(raw)) throw new Error("pricing file: an object is required");
  if (typeof raw.version !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(raw.version)) throw new Error("pricing file: version must start with a date");
  if (raw.currency !== "USD") throw new Error("pricing file: currency must be USD");
  if (!Array.isArray(raw.prices) || !Array.isArray(raw.aliases)) throw new Error("pricing file: prices and aliases are lists");
  const seen = new Set<string>();
  raw.prices.forEach((p: unknown, i: number) => {
    const where = `prices[${i}]`;
    if (!isObj(p)) throw new Error(`${where} must be an object`);
    if (typeof p.provider !== "string" || !/^[a-z0-9_.-]+$/.test(p.provider)) throw new Error(`${where}.provider must be a lowercase id`);
    if (!Array.isArray(p.models) || !p.models.length) throw new Error(`${where}.models must list model ids`);
    if (typeof p.source !== "string" || !OFFICIAL_SOURCE.test(p.source)) throw new Error(`${where}.source must be an official https pricing page`);
    if (p.from !== undefined && (typeof p.from !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.from))) throw new Error(`${where}.from must be YYYY-MM-DD`);
    if (p.longContextAbove !== undefined && !(typeof p.longContextAbove === "number" && p.longContextAbove > 0)) {
      throw new Error(`${where}.longContextAbove must be a token count`);
    }
    for (const tier of ["standard", "fast", "flex", "ultrafast"]) {
      if (tier === "standard" || p[tier] !== undefined) checkTier(p[tier], `${where}.${tier}`, p.longContextAbove !== undefined);
    }
    if (p.usMultiplier !== undefined && !(typeof p.usMultiplier === "number" && p.usMultiplier >= 1 && p.usMultiplier < 2)) {
      throw new Error(`${where}.usMultiplier must be a multiplier`);
    }
    for (const m of p.models) {
      if (typeof m !== "string" || m !== priceModelId(m)) throw new Error(`${where}: model ${String(m)} must be stored as looked up`);
      const key = `${p.provider}/${m}@${p.from ?? ""}`;
      if (seen.has(key)) throw new Error(`${where}: ${key} is priced twice`);
      seen.add(key);
    }
  });
  const aliased = new Set<string>();
  raw.aliases.forEach((a: unknown, i: number) => {
    const where = `aliases[${i}]`;
    if (!isObj(a) || typeof a.model !== "string" || typeof a.price_as !== "string" || typeof a.note !== "string") {
      throw new Error(`${where}: model, price_as and note are required`);
    }
    if (!a.model || !a.price_as || a.model === a.price_as) throw new Error(`${where}: an alias points to another model`);
    if (aliased.has(a.model)) throw new Error(`${where}: ${a.model} is aliased twice`);
    aliased.add(a.model);
  });
  return raw as unknown as PricingFile;
}

/**
 * The model id a price is looked up by: lowercase, without a date suffix
 * (claude-sonnet-4-5-20250929, gpt-5.4-2026-03-05).
 */
export function priceModelId(model: string): string {
  return model.trim().toLowerCase().replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

const FILE = parsePricingFile(PRICING_FILE);

/** Changes with every edit of the priority file (shown next to the values). */
export const PRICING_VERSION = FILE.version;
export const PRICING_CURRENCY = FILE.currency;
export const PRICES: PriceEntry[] = FILE.prices;
export const PRICE_ALIASES: PriceAlias[] = FILE.aliases;

/**
 * Rates the priority file does not have, looked up by the resolved provider
 * (null: none known) and model id: a fallback such as LiteLLM's list.
 * Usage priced from it is flagged unverified.
 */
export interface Catalog {
  find(provider: string | null, model: string): PriceEntry | null;
  /** Long-context thresholds its entries use. */
  thresholds: number[];
}

/** Who sells a bare model id a tool recorded (no provider/ prefix). */
function defaultProvider(tool: string, id: string): string | null {
  if (tool === "claude-code") return "anthropic";
  if (tool === "codex") return "openai";
  // Tools running several providers' models under their bare names.
  if (tool === "cursor" || tool === "antigravity") {
    if (id.startsWith("claude-")) return "anthropic";
    if (/^(gpt-|o\d|codex-)/.test(id)) return "openai";
    if (id.startsWith("gemini-")) return "google";
  }
  return null;
}

/** The provider and model id a stored model is priced as (aliases applied). */
export function resolveModel(tool: string, model: string): { provider: string | null; id: string } {
  const alias = PRICE_ALIASES.find((a) => a.model === model);
  const name = alias ? alias.price_as : model;
  const slash = name.indexOf("/");
  if (slash > 0) return { provider: name.slice(0, slash).toLowerCase(), id: name.slice(slash + 1) };
  return { provider: defaultProvider(tool, priceModelId(name)), id: name };
}

const dayOf = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

/**
 * Days (UTC) where some model's rates change. Usage is grouped by the
 * period between them, so each group falls under one rate per model.
 */
export const PRICE_BOUNDARIES: number[] = [...new Set(PRICES.flatMap((p) => (p.from ? [p.from] : [])))]
  .sort().map((d) => Date.parse(d + "T00:00:00Z") / 1000);

/** Prompt sizes above which some model has long-context rates, ascending (a catalog's included). */
export function longContextThresholds(catalog?: Catalog | null): number[] {
  const own = PRICES.flatMap((p) => (p.longContextAbove ? [p.longContextAbove] : []));
  return [...new Set([...own, ...(catalog?.thresholds ?? [])])].sort((a, b) => a - b);
}

/** The period index of a time (0 before the first boundary). */
export const periodOf = (sec: number) => PRICE_BOUNDARIES.filter((b) => sec >= b).length;

/** The context band of a prompt: how many thresholds it exceeds. */
export const contextBandOf = (promptTokens: number, catalog?: Catalog | null) =>
  longContextThresholds(catalog).filter((t) => promptTokens > t).length;

/** Measured usage sharing every input of its price (one tool, model, tier, region, context band and period). */
export interface PriceGroup {
  tool: string;
  model: string | null;
  service_tier: string | null;
  inference_geo: string | null;
  /** contextBandOf(prompt): how many long-context thresholds its requests exceeded. */
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
  /** Tokens left out: a model, tier or region without a known rate. */
  unpriced_tokens: number;
  /** Some cache writes had no recorded duration and were priced at the cheaper 5-minute rate. */
  lower_bound: boolean;
  /** Some usage predates its model's oldest published rate and was priced at that rate. */
  current_rate_fallback: boolean;
  /** Some usage was priced from the fallback catalog (community rates, not checked against the provider). */
  unverified: boolean;
}

export const emptyValue = (): ApiValue => ({
  usd: null, priced_tokens: 0, unpriced_tokens: 0, lower_bound: false, current_rate_fallback: false, unverified: false,
});

export const groupTokens = (g: PriceGroup) => g.input + g.output + g.cache_read + g.cache_write;

/** The priority entry pricing a model in a period, and whether it is a fallback (usage before its oldest rate). */
function entryFor(provider: string, id: string, period: number): { entry: PriceEntry; fallback: boolean } | null {
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
function tierOf(provider: string, tier: string | null): "standard" | "fast" | "flex" | "ultrafast" | null {
  const t = (tier ?? "").toLowerCase();
  if (t === "" || t === "standard" || t === "default" || t === "auto") return "standard";
  // Claude Code records fast mode as speed "fast"; Anthropic has no other tier here.
  if (provider === "anthropic") return t === "fast" ? "fast" : null;
  // Codex's Fast mode is OpenAI's priority tier (renamed Fast on Jul 30 2026).
  if (t === "fast" || t === "priority") return "fast";
  return t === "flex" || t === "ultrafast" ? t : null;
}

export type PriceResult =
  | { ok: true; usd: number; lowerBound: boolean; fallback: boolean; unverified: boolean }
  | { ok: false; reason: string };

/** The price of one group, or why it has none (shown in the admin panel). */
export function explainPrice(g: PriceGroup, catalog?: Catalog | null): PriceResult {
  if (!g.model) return { ok: false, reason: "no model recorded" };
  const { provider, id } = resolveModel(g.tool, g.model);
  let found = provider ? entryFor(provider, priceModelId(id), g.period) : null;
  let unverified = false;
  if (!found && catalog) {
    const entry = catalog.find(provider, id);
    if (entry) {
      found = { entry, fallback: false };
      unverified = true;
    }
  }
  if (!found) return { ok: false, reason: provider ? "no known rate" : "provider unknown" };
  const { entry, fallback } = found;
  const tierName = tierOf(entry.provider, g.service_tier);
  const tier = tierName ? entry[tierName] : undefined;
  if (!tier) return { ok: false, reason: `no rate for the ${g.service_tier} tier` };
  const long = entry.longContextAbove !== undefined &&
    longContextThresholds(catalog).slice(0, g.band).some((t) => t >= entry.longContextAbove!);
  const rates = long ? tier.long === undefined ? tier.rates : tier.long : tier.rates;
  if (!rates) return { ok: false, reason: "no rate above the long-context threshold" };
  const geo = (g.inference_geo ?? "").toLowerCase();
  let region = 1;
  if (geo === "us" && entry.usMultiplier) region = entry.usMultiplier;
  else if (geo === "us" || !["", "global", "not_available"].includes(geo)) return { ok: false, reason: `no rate for the ${geo} region` };
  if (g.cache_read > 0 && rates.cacheRead === undefined) return { ok: false, reason: "no cache read rate" };
  if (g.cache_write > 0 && rates.cacheWrite === undefined) return { ok: false, reason: "no cache write rate" };
  const write5m = g.cache_write - g.cache_write_1h;
  const usd = (g.input * rates.input + g.output * rates.output + g.cache_read * (rates.cacheRead ?? 0) +
    write5m * (rates.cacheWrite ?? 0) + g.cache_write_1h * (rates.cacheWrite1h ?? rates.cacheWrite ?? 0)) / 1e6 * region;
  // Unsplit Anthropic writes were priced at the 5-minute rate: maybe 1-hour ones.
  const lowerBound = g.cache_write_unsplit > 0 && rates.cacheWrite1h !== undefined && rates.cacheWrite1h > (rates.cacheWrite ?? 0);
  return { ok: true, usd, lowerBound, fallback, unverified };
}

/** USD of one group, or null when it cannot be priced. */
export function priceGroup(g: PriceGroup, catalog?: Catalog | null) {
  const p = explainPrice(g, catalog);
  return p.ok ? p : null;
}

/** Adds a group into a running value (mutates and returns `v`). */
export function addGroup(v: ApiValue, g: PriceGroup, catalog?: Catalog | null): ApiValue {
  const tokens = groupTokens(g);
  const p = priceGroup(g, catalog);
  if (!p) {
    v.unpriced_tokens += tokens;
    return v;
  }
  v.usd = (v.usd ?? 0) + p.usd;
  v.priced_tokens += tokens;
  v.lower_bound ||= p.lowerBound;
  v.current_rate_fallback ||= p.fallback;
  v.unverified ||= p.unverified;
  return v;
}

/** The value of several groups. */
export const valueOf = (groups: Iterable<PriceGroup>, catalog?: Catalog | null): ApiValue => {
  const v = emptyValue();
  for (const g of groups) addGroup(v, g, catalog);
  return v;
};
