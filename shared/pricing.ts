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

/** The rates of one processing tier, and above each long-context threshold when they differ. */
export interface TierRates {
  rates: Rates;
  /**
   * Prompts above each of the entry's `longContextAbove` thresholds, in the
   * same order (the highest one a prompt exceeds applies); null: such
   * requests have no published rate (unpriced). Absent: `rates` at every size.
   */
  long?: (Rates | null)[];
}

export interface PriceEntry {
  /** Who sells at these rates (anthropic, openai, meta, …): the `provider/` of a stored model. */
  provider: string;
  /** Model ids (date/snapshot suffixes stripped, lowercase). */
  models: string[];
  /** First UTC day these rates apply (YYYY-MM-DD); absent: since the model's release. */
  from?: string;
  standard: TierRates;
  /**
   * Prompt sizes (input + cache read + cache write), ascending, above which
   * the matching `long` rates apply to the whole request.
   */
  longContextAbove?: number[];
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

/** Rates beyond this (USD per million tokens) are taken for a typo, here and in the fallback catalog. */
export const MAX_RATE = 1_000;
// The sellers' own pricing pages: Anthropic, OpenAI, OpenCode Zen (its opencode/ models).
const OFFICIAL_SOURCE = /^https:\/\/(platform\.claude\.com|docs\.anthropic\.com|developers\.openai\.com|opencode\.ai)\//;
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

function checkTier(t: unknown, where: string, thresholds: number): void {
  if (!isObj(t)) throw new Error(`${where} must be an object`);
  checkRates(t.rates, `${where}.rates`);
  if (t.long === undefined) return;
  if (!thresholds) throw new Error(`${where}.long needs longContextAbove`);
  if (!Array.isArray(t.long) || t.long.length !== thresholds) {
    throw new Error(`${where}.long must list one rate (or null) per longContextAbove threshold`);
  }
  t.long.forEach((r: unknown, i: number) => { if (r !== null) checkRates(r, `${where}.long[${i}]`); });
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
    const above = p.longContextAbove;
    if (above !== undefined && !(Array.isArray(above) && above.length &&
      above.every((n: unknown, i: number) => Number.isInteger(n) && (n as number) > 0 && (i === 0 || (n as number) > above[i - 1])))) {
      throw new Error(`${where}.longContextAbove must list token counts in ascending order`);
    }
    for (const tier of ["standard", "fast", "flex", "ultrafast"]) {
      if (tier !== "standard" && p[tier] === undefined) continue;
      checkTier(p[tier], `${where}.${tier}`, Array.isArray(above) ? above.length : 0);
      // A threshold needs every tier's rates above it (null: none published), or it would price long requests as short ones.
      if (above !== undefined && (p[tier] as { long?: unknown }).long === undefined) {
        throw new Error(`${where}.${tier}.long is required with longContextAbove (null: no published rate)`);
      }
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
    // The target names who sells it: a rate in this file or LiteLLM's list is looked up by provider.
    if (!/^[a-z0-9_.-]+\/\S+$/.test(a.price_as)) throw new Error(`${where}.price_as must be provider/model`);
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

/**
 * A Cursor model name as the provider's own model id, and the Fast tier when
 * the name asks for it (issue #271). Only Cursor's naming is undone, never a
 * model guessed: Cursor's names put the version before the family
 * (`claude-4.6-opus` is Anthropic's `claude-opus-4-6`) and add the
 * reasoning effort (`-low` … `-xhigh`, `-max`), extended thinking
 * (`-thinking`, billed as output tokens) and the context window (`-1m`;
 * long-context rates follow the measured prompt size), none of which changes
 * the per-token rate; `-fast` is the provider's Fast / priority tier (Cursor
 * lists "GPT-5 Fast" at OpenAI's priority rates and Opus fast mode at
 * Anthropic's). Names from https://cursor.com/docs/models and Cursor's
 * `agent --list-models`. Anything else is returned as it is: Cursor's own
 * models (`composer-…`), `auto`, `default` and names of unknown shape stay
 * unpriced unless they already are a provider's id.
 */
export function cursorModel(name: string): { id: string; tier: "fast" | null } {
  const id = priceModelId(name);
  const claude = /^claude-(\d+(?:\.\d+)?)-(opus|sonnet|haiku)(?:-1m)?(?:-(?:low|medium|high|xhigh|max))?(?:-thinking)?(-fast)?$/.exec(id);
  if (claude) return { id: `claude-${claude[2]}-${claude[1].replace(".", "-")}`, tier: claude[3] ? "fast" : null };
  const gpt = /^(gpt-\d+(?:\.\d+)?(?:-[a-z]+)*?)(?:-(?:none|minimal|low|medium|high|xhigh))?(-fast)?$/.exec(id);
  if (gpt) return { id: gpt[1], tier: gpt[2] ? "fast" : null };
  return { id: name, tier: null };
}

/** The provider and model id a stored model is priced as (aliases applied), and a tier its name implies. */
export function resolveModel(tool: string, model: string): { provider: string | null; id: string; tier: string | null } {
  const alias = PRICE_ALIASES.find((a) => a.model === model);
  const name = alias ? alias.price_as : model;
  const slash = name.indexOf("/");
  if (slash > 0) return { provider: name.slice(0, slash).toLowerCase(), id: name.slice(slash + 1), tier: null };
  const { id, tier } = tool === "cursor" && !alias ? cursorModel(name) : { id: name, tier: null };
  return { provider: defaultProvider(tool, priceModelId(id)), id, tier };
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
  const own = PRICES.flatMap((p) => p.longContextAbove ?? []);
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

/** The price of one group at one entry's rates, or why that entry cannot price it. */
function priceAt(g: PriceGroup, entry: PriceEntry, fallback: boolean, unverified: boolean, catalog?: Catalog | null): PriceResult {
  const tierName = tierOf(entry.provider, g.service_tier);
  const tier = tierName ? entry[tierName] : undefined;
  if (!tier) return { ok: false, reason: `no rate for the ${g.service_tier} tier` };
  // The band counts every known threshold the prompt exceeded (the SQL
  // grouping, from the same list): the entry's level is how many of its own
  // thresholds are at or below the largest one exceeded.
  const exceeded = longContextThresholds(catalog).slice(0, g.band);
  const top = exceeded.length ? exceeded[exceeded.length - 1] : 0;
  const level = (entry.longContextAbove ?? []).filter((t) => t <= top).length;
  // A tier without long-context rates (a catalog entry) is unpriced above the threshold, never priced as short.
  const rates = level === 0 ? tier.rates : tier.long?.[level - 1];
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

/**
 * The price of one group, or why it has none (shown in the admin panel).
 * The priority file first; when its entry lacks what the group needs (a
 * tier, a region, a long-context or cache rate), the fallback catalog's
 * entry for the same model is tried, so a partial verified entry never
 * hides a complete community one.
 */
export function explainPrice(g: PriceGroup, catalog?: Catalog | null): PriceResult {
  if (!g.model) return { ok: false, reason: "no model recorded" };
  const { provider, id, tier } = resolveModel(g.tool, g.model);
  // A tier the model name implies (Cursor's `-fast`), unless one was recorded.
  if (tier && !g.service_tier) g = { ...g, service_tier: tier };
  const own = provider ? entryFor(provider, priceModelId(id), g.period) : null;
  const first = own ? priceAt(g, own.entry, own.fallback, false, catalog) : null;
  if (first?.ok) return first;
  const listed = catalog?.find(provider, id) ?? null;
  const second = listed ? priceAt(g, listed, false, true, catalog) : null;
  if (second?.ok) return second;
  return first ?? second ?? { ok: false, reason: provider ? "no known rate" : "provider unknown" };
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
