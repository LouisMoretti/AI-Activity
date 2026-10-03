// API-equivalent value (shared/pricing.ts): published retail rates applied to
// measured token groups, with unpriced usage and assumptions flagged.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  contextBandOf, periodOf, priceGroup, priceModelId, PRICES, valueOf,
} from "../shared/pricing.ts";

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

  test("subscription-only models, other providers and other tools are unpriced", () => {
    assert.equal(usd(codex({ model: "codex-auto-review", input: M })), null);
    assert.equal(usd(codex({ model: "gpt-5.3-codex-spark", input: M })), null);
    assert.equal(usd(codex({ model: "ollama/gpt-6-sol", input: M })), null);
    assert.equal(usd(codex({ model: "claude-opus-5-5", input: M })), null);
    assert.equal(usd({ tool: "cursor", model: "claude-opus-5-5", input: M }), null);
    assert.equal(usd({ tool: "opencode", model: "openai/gpt-6-sol", input: M }), null);
  });
});

test("a value adds priced groups and counts the rest apart; nothing priced is null, not $0", () => {
  const v = valueOf([group({ input: M }), group({ tool: "cursor", input: 300 }), group({ model: "mystery", output: 200 })]);
  close(v.usd, 4);
  assert.equal(v.priced_tokens, M);
  assert.equal(v.unpriced_tokens, 500);
  assert.deepEqual(valueOf([group({ tool: "cursor", input: 1 })]),
    { usd: null, priced_tokens: 0, unpriced_tokens: 1, lower_bound: false, current_rate_fallback: false });
  assert.equal(valueOf([]).usd, null);
});

test("every rate has an official https source and each model one rate per effective day", () => {
  const seen = new Set();
  for (const p of PRICES) {
    assert.match(p.source, /^https:\/\/(platform\.claude\.com|docs\.anthropic\.com|developers\.openai\.com)\//, p.models.join());
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
