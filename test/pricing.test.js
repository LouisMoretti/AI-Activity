// API-equivalent value (shared/pricing.ts): published retail rates applied to
// measured token groups, with unpriced usage and assumptions flagged.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  contextBandOf, explainPrice, parsePricingFile, periodOf, priceGroup, priceModelId, PRICES, valueOf,
} from "../shared/pricing.ts";
import { catalogOf, toEntry } from "../server/lib/litellm.ts";

const M = 1_000_000;
/** A group with only the given counts; `at` dates it (pricing period). */
function group(over = {}, at = Date.parse("2026-10-01T00:00:00Z") / 1000) {
  return {
    tool: "claude-code", model: "claude-opus-5-5", service_tier: null, inference_geo: null, band: 0, period: periodOf(at),
    input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0, cache_write_unsplit: 0, ...over,
  };
}
const usd = (over, at) => priceGroup(group(over, at))?.usd ?? null;
const close = (actual, expected) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

describe("Anthropic rates", () => {
  test("each token category at its own rate, 1-hour writes at 2× input", () => {
    // Opus 5.5: $4 in, $20 out, reads 0.05×, 5-minute writes 1.25×, 1-hour writes 2×.
    close(usd({ input: M, output: M, cache_read: M, cache_write: 2 * M, cache_write_1h: M }), 4 + 20 + 0.2 + 5 + 8);
    const p = priceGroup(group({ cache_write: M, cache_write_1h: M }));
    assert.equal(p.lowerBound, false);
    assert.equal(p.fallback, false);
  });

  test("writes without a recorded duration: the 5-minute rate, flagged as a lower bound", () => {
    const p = priceGroup(group({ cache_write: M, cache_write_unsplit: M }));
    close(p.usd, 5);
    assert.equal(p.lowerBound, true);
  });

  test("dated model ids are priced like their alias; other ids stay unpriced", () => {
    assert.equal(priceModelId("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
    assert.equal(priceModelId("gpt-5.4-2026-03-05"), "gpt-5.4");
    close(usd({ model: "claude-sonnet-4-5-20250929", input: M }), 3);
    assert.equal(usd({ model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", input: M }), null);
    assert.equal(usd({ model: "<synthetic>", input: M }), null);
    assert.equal(usd({ model: null, input: M }), null);
  });

  test("fast mode, US-only inference and long context where they are published", () => {
    close(usd({ service_tier: "fast", input: M, output: M }), 8 + 40);
    // No published fast rate for Opus 4.6 here: unpriced, not standard.
    assert.equal(usd({ model: "claude-opus-4-6", service_tier: "fast", input: M }), null);
    close(usd({ inference_geo: "us", input: M }), 4.4);
    close(usd({ inference_geo: "global", input: M }), 4);
    close(usd({ inference_geo: "not_available", input: M }), 4);
    // Claude 4.5 and earlier do not support inference_geo; unknown regions are unpriced.
    assert.equal(usd({ model: "claude-opus-4-5", inference_geo: "us", input: M }), null);
    assert.equal(usd({ inference_geo: "eu", input: M }), null);
    // Sonnet 4.5 above 200K prompt tokens: 2× input (and cache), 1.5× output for the whole request.
    const long = contextBandOf(250_000);
    close(usd({ model: "claude-sonnet-4-5", band: long, input: M, output: M, cache_read: M }), 6 + 22.5 + 0.6);
    close(usd({ model: "claude-sonnet-4-5", band: 0, input: M, output: M }), 3 + 15);
    // Claude 4.6 and later: standard rates across the full context.
    close(usd({ band: contextBandOf(900_000), input: M }), 4);
  });

  test("a tier the tool never records as standard is unpriced", () => {
    assert.equal(usd({ service_tier: "priority", input: M }), null);
    close(usd({ service_tier: "standard", input: M }), 4);
  });
});

describe("OpenAI rates", () => {
  const codex = (over) => ({ tool: "codex", model: "gpt-6-sol", ...over });

  test("standard, long context above 272K, Fast (priority), Flex and Ultrafast", () => {
    close(usd(codex({ input: M, cache_read: M, cache_write: M, output: M })), 2 + 0.2 + 2.5 + 10);
    assert.equal(contextBandOf(250_000), 1);
    close(usd(codex({ band: contextBandOf(250_000), input: M })), 2); // above 200K, not above 272K
    close(usd(codex({ band: contextBandOf(300_000), input: M, output: M })), 4 + 15);
    close(usd(codex({ service_tier: "priority", input: M })), 4);
    close(usd(codex({ service_tier: "fast", input: M })), 4);
    close(usd(codex({ service_tier: "default", input: M })), 2);
    close(usd(codex({ service_tier: "flex", input: M })), 1);
    assert.equal(usd(codex({ service_tier: "ultrafast", input: M })), null);
    close(usd(codex({ model: "gpt-6-astra", service_tier: "ultrafast", output: M })), 300);
  });

  test("models without a cache-write rate bill writes as input; Fast long context unpublished is unpriced", () => {
    close(usd(codex({ model: "gpt-5.5", cache_write: M })), 5);
    assert.equal(priceGroup(group(codex({ model: "gpt-5.5", cache_write: M, cache_write_unsplit: M }))).lowerBound, false);
    assert.equal(usd(codex({ model: "gpt-5.5", service_tier: "priority", band: contextBandOf(300_000), input: M })), null);
    close(usd(codex({ model: "gpt-5.5", service_tier: "priority", input: M })), 12.5);
  });

  test("rates take effect on their day; older usage falls back to them, flagged", () => {
    const before = priceGroup(group(codex({ model: "gpt-5.6-sol", input: M }), Date.parse("2026-08-01T00:00:00Z") / 1000));
    close(before.usd, 4);
    assert.equal(before.fallback, true);
    const after = priceGroup(group(codex({ model: "gpt-5.6-sol", input: M }), Date.parse("2026-08-21T00:00:00Z") / 1000));
    assert.equal(after.fallback, false);
    // Luna's rates changed on Jul 30: the period from Aug 21 is covered too.
    assert.equal(priceGroup(group(codex({ model: "gpt-5.6-luna", input: M }), Date.parse("2026-09-01T00:00:00Z") / 1000)).fallback, false);
    assert.equal(priceGroup(group(codex({ model: "gpt-5.6-luna", input: M }), Date.parse("2026-07-29T00:00:00Z") / 1000)).fallback, true);
  });

  test("a model recorded with a non-OpenAI provider never gets OpenAI's verified rate (#279)", () => {
    assert.equal(usd(codex({ model: "gpt-5.4", input: M })), 2.5);
    assert.deepEqual(explainPrice(group(codex({ model: "azure/gpt-5.4", input: M }))), { ok: false, reason: "no known rate" });
  });

  test("subscription-only models and other providers' models are unpriced", () => {
    assert.equal(usd(codex({ model: "codex-auto-review", input: M })), null);
    assert.equal(usd(codex({ model: "gpt-5.3-codex-spark", input: M })), null);
    assert.equal(usd(codex({ model: "ollama/gpt-6-sol", input: M })), null);
    assert.equal(usd(codex({ model: "claude-opus-5-5", input: M })), null);
  });
});

test("a value adds priced groups and counts the rest apart; nothing priced is null, not $0", () => {
  const v = valueOf([group({ input: M }), group({ tool: "opencode", model: "agentrouter/glm-5.3", input: 300 }), group({ model: "mystery", output: 200 })]);
  close(v.usd, 4);
  assert.equal(v.priced_tokens, M);
  assert.equal(v.unpriced_tokens, 500);
  assert.deepEqual(valueOf([group({ tool: "cursor", model: "composer-2.5", input: 1 })]),
    { usd: null, priced_tokens: 0, unpriced_tokens: 1, lower_bound: false, current_rate_fallback: false, unverified: false });
  assert.equal(valueOf([]).usd, null);
});

test("every rate has an official https source and each model one rate per effective day", () => {
  const seen = new Set();
  for (const p of PRICES) {
    assert.match(p.source, /^https:\/\/(platform\.claude\.com|docs\.anthropic\.com|developers\.openai\.com|opencode\.ai)\//, p.models.join());
    for (const m of p.models) {
      assert.equal(m, priceModelId(m), `${m} is stored as looked up`);
      const key = `${p.provider}:${m}:${p.from ?? ""}`;
      assert.ok(!seen.has(key), `${key} listed twice`);
      seen.add(key);
    }
    for (const r of [p.standard.rates, p.standard.long].filter(Boolean)) {
      for (const n of Object.values(r)) assert.ok(Number.isFinite(n) && n >= 0, p.models.join());
    }
  }
});

describe("the priority file (shared/pricing.json)", () => {
  const file = () => JSON.parse(fs.readFileSync(new URL("../shared/pricing.json", import.meta.url), "utf8"));
  const broken = (edit) => { const f = file(); edit(f); return () => parsePricingFile(f); };

  test("the shipped file is valid", () => {
    assert.doesNotThrow(() => parsePricingFile(file()));
  });

  test("a bad edit is refused, so it fails the tests and the server's start", () => {
    assert.throws(broken((f) => { delete f.prices[0].source; }), /source/);
    assert.throws(broken((f) => { f.prices[0].source = "https://example.com/prices"; }), /official/);
    assert.throws(broken((f) => { f.prices[0].standard.rates.input = -1; }), /rate/);
    assert.throws(broken((f) => { f.prices[0].standard.rates.inputs = 1; }), /unknown rate/);
    assert.throws(broken((f) => { delete f.prices[0].standard.rates.output; }), /required/);
    assert.throws(broken((f) => { f.prices[0].models.push("Claude-Opus-9-20250101"); }), /looked up/);
    assert.throws(broken((f) => { f.prices.push(f.prices[0]); }), /twice/);
    assert.throws(broken((f) => { f.aliases.push({ model: "a/b", price_as: "a/b", note: "" }); }), /another model/);
    assert.throws(broken((f) => { f.aliases.push({ ...f.aliases[0] }); }), /aliased twice/);
    assert.throws(broken((f) => { f.prices[0].standard.long = f.prices[0].standard.rates; }), /longContextAbove/);
    assert.throws(broken((f) => { f.prices[0].longContextAbove = 200000; }), /standard\.long is required/);
    assert.throws(broken((f) => { f.aliases[0].price_as = "muse-spark-1.3-contributor"; }), /provider\/model/);
    assert.throws(broken((f) => { f.prices[0].standard.rates.output = 5000; }), /rate/);
  });

  test("every tool is priced when its model resolves to a known rate", () => {
    close(usd({ tool: "cursor", model: "claude-opus-5-5", input: M }), 4);
    close(usd({ tool: "antigravity", model: "claude-opus-5-5", input: M }), 4);
    close(usd({ tool: "opencode", model: "openai/gpt-6-sol", input: M }), 2);
    close(usd({ tool: "opencode", model: "anthropic/claude-sonnet-5", input: M }), 2);
    // A bare name nobody can attribute: no provider, no price.
    assert.deepEqual(explainPrice(group({ tool: "cursor", model: "composer-2.5", input: M })), { ok: false, reason: "provider unknown" });
  });
});

describe("the LiteLLM fallback (server/lib/litellm.ts)", () => {
  const e = (input, output, more = {}) => ({ litellm_provider: "meta", mode: "chat", input_cost_per_token: input / M, output_cost_per_token: output / M, ...more });
  const LIST = {
    sample_spec: { litellm_provider: "one of https://docs.litellm.ai/docs/providers", input_cost_per_token: 0 },
    "meta/muse-spark-1.3-contributor": e(0.1, 0.2, { cache_read_input_token_cost: 0.002 / M }),
    // A reseller's rate for the same model: never used for meta's.
    "openrouter/meta/muse-spark-1.3-contributor": e(9, 9, { litellm_provider: "openrouter" }),
    "novita/deepseek/deepseek-v4-flash": e(0.14, 0.28, { litellm_provider: "novita", cache_read_input_token_cost: 0.028 / M }),
    "zai/glm-5.3-flash": e(0.15, 0.5, { litellm_provider: "zai", cache_read_input_token_cost: 0.03 / M }),
    "gpt-9": e(1, 8, {
      litellm_provider: "openai", cache_read_input_token_cost: 0.1 / M,
      input_cost_per_token_priority: 2 / M, output_cost_per_token_priority: 16 / M,
      input_cost_per_token_above_272k_tokens: 2 / M, output_cost_per_token_above_272k_tokens: 12 / M,
    }),
    "claude-opus-5-5": e(40, 200, { litellm_provider: "anthropic" }), // the priority file wins
    // Fast mode the priority file has no rate for (Opus 4.6).
    "claude-opus-4-6": e(5, 25, { litellm_provider: "anthropic", input_cost_per_token_priority: 30 / M, output_cost_per_token_priority: 150 / M }),
    "claude-next": e(3, 15, { litellm_provider: "anthropic", cache_read_input_token_cost: 0.3 / M,
      cache_creation_input_token_cost: 3.75 / M, cache_creation_input_token_cost_above_1hr: 6 / M }),
    "no-cache-model": e(1, 2, { litellm_provider: "mistral" }),
    "dall-e-9": { litellm_provider: "openai", mode: "image_generation", input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
    "typo-model": e(1, 2, { litellm_provider: "mistral", input_cost_per_token: 5 }),
    "half-model": { litellm_provider: "mistral", mode: "chat", input_cost_per_token: 1e-6 },
  };
  const catalog = catalogOf(LIST);
  const priced = (over) => priceGroup(group(over), catalog);

  test("text models with input and output rates only, in USD per million tokens", () => {
    assert.equal(catalog.size, 9);
    assert.equal(toEntry("dall-e-9", LIST["dall-e-9"]), null);
    assert.equal(toEntry("typo-model", LIST["typo-model"]), null);
    assert.equal(toEntry("half-model", LIST["half-model"]), null);
    assert.deepEqual(toEntry("claude-next", LIST["claude-next"]).standard.rates,
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 });
    assert.deepEqual(catalog.thresholds, [272000]);
  });

  test("OpenCode's free Muse Spark is priced at Meta's contributor rate through its alias, unverified", () => {
    const g = { tool: "opencode", model: "opencode/muse-spark-1.3-contributor-free", input: M, output: M, cache_read: M };
    const p = priced(g);
    close(p.usd, 0.1 + 0.2 + 0.002);
    assert.equal(p.unverified, true);
    // OpenCode's stealth preview "Ox Alpha" is GLM-5.3-Flash: OpenCode Zen's own verified rate, no list needed.
    const ox = priceGroup(group({ tool: "opencode", model: "opencode/x-preview-f-free", input: M, output: M, cache_read: M }));
    close(ox.usd, 0.15 + 0.5 + 0.03);
    assert.equal(ox.unverified, false);
    // Without the list there is no rate: unpriced, never $0.
    assert.deepEqual(explainPrice(group(g)), { ok: false, reason: "no known rate" });
  });

  test("only the provider's own rate, under LiteLLM's provider names", () => {
    close(priced({ tool: "opencode", model: "novita-ai/deepseek/deepseek-v4-flash", input: M })?.usd ?? null, 0.14);
    close(priced({ tool: "opencode", model: "meta/muse-spark-1.3-contributor", input: M }).usd, 0.1);
    assert.equal(priced({ tool: "opencode", model: "agentrouter/muse-spark-1.3-contributor", input: M }), null);
    assert.equal(catalog.find(null, "gpt-9"), null);
  });

  test("tiers, long context and cache durations from LiteLLM's fields; the priority file first", () => {
    close(priced({ tool: "codex", model: "gpt-9", input: M, cache_read: M }).usd, 1.1);
    close(priced({ tool: "codex", model: "gpt-9", service_tier: "priority", input: M }).usd, 2);
    close(priced({ tool: "codex", model: "gpt-9", band: contextBandOf(300_000, catalog), output: M }).usd, 12);
    // OpenAI cache writes without a write rate are billed as input.
    close(priced({ tool: "codex", model: "gpt-9", cache_write: M }).usd, 1);
    close(priced({ model: "claude-next", cache_write: 2 * M, cache_write_1h: M }).usd, 3.75 + 6);
    const own = priced({ input: M });
    close(own.usd, 4);
    assert.equal(own.unverified, false);
  });

  test("a priority entry lacking a tier falls back to the list's entry for the same model, not to unpriced", () => {
    const fast = priced({ model: "claude-opus-4-6", service_tier: "fast", input: M });
    close(fast.usd, 30);
    assert.equal(fast.unverified, true);
    // The standard tier stays on the verified rate.
    const std = priced({ model: "claude-opus-4-6", input: M });
    close(std.usd, 5);
    assert.equal(std.unverified, false);
    // Without the list: unpriced, with the priority entry's reason.
    assert.deepEqual(explainPrice(group({ model: "claude-opus-4-6", service_tier: "fast", input: M })), { ok: false, reason: "no rate for the fast tier" });
  });

  test("a category with tokens but no rate leaves the group unpriced, with why", () => {
    assert.deepEqual(explainPrice(group({ tool: "opencode", model: "mistral/no-cache-model", input: M, cache_read: 1 }), catalog),
      { ok: false, reason: "no cache read rate" });
    close(priced({ tool: "opencode", model: "mistral/no-cache-model", input: M }).usd, 1);
  });
});
