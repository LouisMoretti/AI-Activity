// LiteLLM's community model price list as the fallback pricing catalog
// (shared/pricing.ts, issue #268): models the priority file does not price.
// Downloaded at most once a day and kept next to the database, so a restart
// or GitHub being down changes nothing; a download that fails or does not
// look like the price list keeps the copy already there. Usage priced from
// it is flagged unverified: nobody checked these rates against the provider.
import fs from "node:fs";
import path from "node:path";
import { priceModelId, type Catalog, type PriceEntry, type Rates, type TierRates } from "../../shared/pricing.ts";

export const DEFAULT_LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const REFRESH_SEC = 86400;
const MAX_BYTES = 50 * 1024 * 1024;
/** Text model modes; image, audio and embedding prices are not per text token. */
const MODES = new Set(["chat", "responses", "completion"]);
/** Per-token costs beyond this ($1,000 per million tokens) are taken for a mistake. */
const MAX_COST = 1e-3;

/** LiteLLM's provider names for a provider id as tools store it (provider/model). */
const PROVIDER_NAMES: Record<string, string[]> = {
  google: ["gemini", "vertex_ai-language-models"],
  "novita-ai": ["novita"],
  together: ["together_ai"],
  togetherai: ["together_ai"],
  fireworks: ["fireworks_ai"],
  "z-ai": ["zai"],
  zhipuai: ["zai"],
  moonshotai: ["moonshot"],
  "amazon-bedrock": ["bedrock_converse", "bedrock"],
  "google-vertex": ["vertex_ai-language-models"],
};
const providerNames = (p: string) => [p, ...(PROVIDER_NAMES[p] ?? [])];

type Raw = Record<string, unknown>;
const cost = (raw: Raw, key: string): number | undefined => {
  const v = raw[key];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_COST ? v * 1e6 : undefined;
};

/** One tier's rates from LiteLLM's field names (suffix: "", "_priority", "_above_272k_tokens", …). */
function ratesOf(raw: Raw, suffix: string, provider: string): Rates | null {
  const input = cost(raw, `input_cost_per_token${suffix}`);
  const output = cost(raw, `output_cost_per_token${suffix}`);
  if (input === undefined || output === undefined) return null;
  const r: Rates = { input, output };
  const read = cost(raw, `cache_read_input_token_cost${suffix}`);
  // OpenAI bills cache writes as input where no write rate is listed.
  const write = cost(raw, `cache_creation_input_token_cost${suffix}`) ??
    (provider === "openai" || provider === "azure" ? input : undefined);
  const write1h = suffix === "" ? cost(raw, "cache_creation_input_token_cost_above_1hr") : undefined;
  if (read !== undefined) r.cacheRead = read;
  if (write !== undefined) r.cacheWrite = write;
  if (write1h !== undefined) r.cacheWrite1h = write1h;
  return r;
}

/** A LiteLLM entry as a price entry, or null when it is not a priced text model. */
export function toEntry(key: string, raw: unknown): PriceEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Raw;
  const provider = typeof r.litellm_provider === "string" ? r.litellm_provider : "";
  if (!provider || (r.mode !== undefined && !MODES.has(String(r.mode)))) return null;
  const standard = ratesOf(r, "", provider);
  if (!standard) return null;
  // The smallest long-context threshold with its own input rate applies to the whole request.
  const above = Object.keys(r).flatMap((k) => /^input_cost_per_token_above_(\d+)k_tokens$/.exec(k)?.[1] ?? [])
    .map(Number).sort((a, b) => a - b)[0];
  const longSuffix = above ? `_above_${above}k_tokens` : null;
  const tier = (suffix: string): TierRates | undefined => {
    const rates = ratesOf(r, suffix, provider);
    if (!rates) return undefined;
    return longSuffix ? { rates, long: ratesOf(r, longSuffix + suffix, provider) } : { rates };
  };
  const entry: PriceEntry = {
    provider, models: [key], standard: tier("")!, source: `litellm:${key}`,
  };
  if (longSuffix) entry.longContextAbove = above * 1000;
  const fast = tier("_priority");
  const flex = tier("_flex");
  if (fast) entry.fast = fast;
  if (flex) entry.flex = flex;
  return entry;
}

/** The catalog of a LiteLLM price list (entries by lowercase key). */
export function catalogOf(list: Record<string, unknown>): Catalog & { size: number } {
  const byKey = new Map<string, PriceEntry>();
  for (const [key, raw] of Object.entries(list)) {
    const entry = toEntry(key, raw);
    if (entry) byKey.set(key.toLowerCase(), entry);
  }
  const thresholds = [...new Set([...byKey.values()].flatMap((e) => (e.longContextAbove ? [e.longContextAbove] : [])))];
  return {
    size: byKey.size,
    thresholds,
    // Only the provider's own rate: never another provider's price for the
    // same model name (a reseller's is not the provider's).
    find(provider, model) {
      if (!provider) return null;
      const names = providerNames(provider);
      for (const id of new Set([model.toLowerCase(), priceModelId(model)])) {
        for (const name of names) {
          const prefixed = byKey.get(`${name}/${id}`);
          if (prefixed && names.includes(prefixed.provider)) return prefixed;
        }
        const bare = byKey.get(id);
        if (bare && names.includes(bare.provider)) return bare;
      }
      return null;
    },
  };
}

export interface LiteLLMStatus {
  /** Where the list is downloaded from; null: the fallback catalog is off. */
  url: string | null;
  /** When the copy in use was downloaded; null: none yet. */
  fetched_at: number | null;
  /** Priced text models in it. */
  models: number;
  /** Why the last download failed (the copy in use stays), or null. */
  error: string | null;
}

/** The fallback catalog of this server, refreshed in the background. */
export interface LiteLLM {
  catalog(): Catalog | null;
  status(): LiteLLMStatus;
  /** Downloads the list now (also on its own once a day). */
  refresh(): Promise<void>;
  stop(): void;
}

/**
 * Starts the fallback catalog: loads the copy kept at `cacheFile`, then
 * downloads a new one if it is missing or more than a day old, and checks
 * again every hour. `url` null: off.
 */
export function startLiteLLM(url: string | null, cacheFile: string, now = () => Math.floor(Date.now() / 1000)): LiteLLM {
  let current: (Catalog & { size: number }) | null = null;
  let fetchedAt: number | null = null;
  let error: string | null = null;
  let running: Promise<void> | null = null;

  try {
    const saved = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as { fetched_at?: unknown; list?: unknown };
    if (url && typeof saved.fetched_at === "number" && saved.list && typeof saved.list === "object") {
      const c = catalogOf(saved.list as Record<string, unknown>);
      if (c.size) [current, fetchedAt] = [c, saved.fetched_at];
    }
  } catch {
    // No copy yet (or an unreadable one): the first download makes it.
  }

  async function download(): Promise<void> {
    if (!url) return;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const length = Number(res.headers.get("content-length") ?? 0);
      if (length > MAX_BYTES) throw new Error("too large");
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error("too large");
      const list = JSON.parse(text) as unknown;
      if (!list || typeof list !== "object" || Array.isArray(list)) throw new Error("not a price list");
      const c = catalogOf(list as Record<string, unknown>);
      if (!c.size) throw new Error("no priced text model in it");
      // Kept trimmed to what is priced, written whole before it replaces the copy.
      const kept = Object.fromEntries(Object.entries(list).filter(([k, v]) => toEntry(k, v)));
      const at = now();
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(`${cacheFile}.tmp`, JSON.stringify({ url, fetched_at: at, list: kept }), { mode: 0o600 });
      fs.renameSync(`${cacheFile}.tmp`, cacheFile);
      [current, fetchedAt, error] = [c, at, null];
    } catch (e) {
      error = (e as Error).message || String(e);
      console.error(`LiteLLM price list not updated (${url}): ${error}`);
    }
  }

  const refresh = () => (running ??= download().finally(() => { running = null; }));
  const due = () => url !== null && (fetchedAt === null || now() - fetchedAt >= REFRESH_SEC);
  if (due()) void refresh();
  const timer = setInterval(() => { if (due()) void refresh(); }, 3600_000);
  timer.unref();

  return {
    catalog: () => current,
    status: () => ({ url, fetched_at: fetchedAt, models: current?.size ?? 0, error }),
    refresh,
    stop: () => clearInterval(timer),
  };
}
