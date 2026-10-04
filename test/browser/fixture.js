// Fictional usage for the browser tests: a real test server (temp DB, fake
// GitHub) whose admin account gets made-up messages chosen to exercise every
// API-value caveat and long model names. Never real measurements.
import { codexResponse, collector, event, newDevice, opencodeMessage, req, startServer } from "../helpers.js";

const now = () => Math.floor(Date.now() / 1000);

async function ingest(srv, key, tool, body) {
  const r = await req(srv.base, "POST", `/api/ingest/${tool}`, { key, body: { collector: collector(tool), ...body } });
  if (r.status !== 200) throw new Error(`ingest ${tool}: ${r.status} ${r.text}`);
}

/** Starts a server with the fixture; resolves with it (`stop()` when done). */
export async function fixtureServer() {
  const srv = await startServer();
  const { key } = await newDevice(srv.base, "browser-test");
  const t = now();

  // Claude Code: cache writes without their 5m / 1h split (lower bound) and
  // two unpriced models with long names (partial, several reasons).
  const cc = (over) => ({ ...event({ session_id: "cc-caveats-0001", occurred_at: t - 60, ...over }), tool: undefined });
  await ingest(srv, key, "claude-code", {
    messages: [
      cc({ usage: { input_tokens: 4000, output_tokens: 9000, cache_creation_input_tokens: 120000, cache_read_input_tokens: 300000 } }),
      cc({ model: "claude-fictional-unreleased-model-with-a-very-long-name-20991231" }),
      cc({ model: "another-fictional-model-nobody-prices" }),
    ].map(({ event_id, ...m }) => ({ ...m, message_id: event_id })),
  });

  // Codex: usage dated before its model's oldest published rate.
  await ingest(srv, key, "codex", {
    messages: [codexResponse({ session_id: "cx-fallback-0001", model: "gpt-5.6", occurred_at: Date.UTC(2026, 7, 1) / 1000 })],
  });

  // OpenCode: the issue's openai/gpt-5.2 row (18 calls, 760K tokens), plus
  // a long provider/model name nobody prices, both active now.
  const share = Math.floor(760_000 / 18);
  const gpt = Array.from({ length: 18 }, (_, i) => opencodeMessage({
    session_id: "ses_fixture_gpt52", provider_id: "openai", model_id: "gpt-5.2", occurred_at: t - 30 - i,
    usage: { input_tokens: share - 1000, output_tokens: 1000, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: share },
  }));
  const long = opencodeMessage({
    session_id: "ses_fixture_long", provider_id: "fictional-provider-with-long-name", model_id: "fictional-model-extended-preview-20991231", occurred_at: t - 20,
  });
  await ingest(srv, key, "opencode", { messages: [...gpt, long] });
  return srv;
}
