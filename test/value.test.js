import assert from "node:assert/strict";
import { test } from "node:test";
import { priceEvent } from "../server/lib/value.ts";
import { startServer, req, newDevice, event, codexResponse, collector } from "./helpers.js";

const base = { source: "message", tool: "codex", model: "gpt-6-astra", input_tokens: 100,
  output_tokens: 40, cache_read_tokens: 200, cache_write_tokens: 0, occurred_at: 1_900_000_000, received_at: 1_900_000_001 };

test("pricing uses separate cache rates, context tier and unavailable states", () => {
  assert.equal(priceEvent(base).usd, (100 * 10 + 40 * 50 + 200) / 1_000_000);
  assert.equal(priceEvent({ ...base, input_tokens: 300_000 }).usd, (300_000 * 20 + 40 * 75 + 200 * 2) / 1_000_000);
  assert.deepEqual(priceEvent({ ...base, model: "no-retail-equivalent" }), { reason: "unknown_model" });
  assert.deepEqual(priceEvent({ ...base, model: "anthropic/gpt-6-astra" }), { reason: "unknown_model" });
  assert.deepEqual(priceEvent({ ...base, model: "claude-sonnet-5", cache_write_tokens: 10 }), { reason: "insufficient_detail" });
  assert.deepEqual(priceEvent({ ...base, source: "snapshot" }), { reason: "snapshot" });
});

test("profile and leaderboard share the same valuation and show partial coverage", async () => {
  const srv = await startServer();
  try {
    const key = (await newDevice(srv.base)).key;
    const known = await req(srv.base, "POST", "/api/ingest/codex", { key, body: { messages: [codexResponse({
      usage: { input_tokens: 300, cached_input_tokens: 200, output_tokens: 40 },
    })], collector: collector("codex") } });
    assert.equal(known.status, 200);
    const unknown = await req(srv.base, "POST", "/api/ingest/claude-code", { key,
      body: event({ model: "model-without-retail-rate", usage: { input_tokens: 100, output_tokens: 50 } }) });
    assert.equal(unknown.status, 200);
    const profile = await req(srv.base, "GET", "/api/u/admin/value", { anon: true });
    const board = await req(srv.base, "GET", "/api/leaderboard?days=all", { anon: true });
    assert.equal(profile.status, 200);
    assert.equal(board.status, 200);
    assert.equal(profile.json.currency, "USD");
    assert.equal(profile.json.total.priced_events, 1);
    assert.equal(profile.json.total.total_events, 2);
    assert.equal(profile.json.total.usd, board.json.entries.find((e) => e.username === "admin").value.usd);
    assert.equal(profile.json.total.usd, board.json.value.usd);
    assert.equal(profile.json.total.priced_tokens, 340);
    assert.equal(profile.json.total.total_tokens, 490);
  } finally { await srv.stop(); }
});
