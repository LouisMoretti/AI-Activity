import assert from "node:assert/strict";
import { test } from "node:test";
import { event, githubSignIn, newDevice, req, startServer } from "./helpers.js";

test("sample generation is preview-only, admin-only, explicit, and configurable", async () => {
  const srv = await startServer({ env: { PREVIEW_MODE: "1" } });
  try {
    const endpoint = "/api/admin/preview-seed";
    assert.equal((await req(srv.base, "GET", "/api/auth/status", { anon: true })).json.preview, true);
    assert.deepEqual((await req(srv.base, "GET", "/api/profiles", { anon: true })).json.profiles.map((p) => p.username), ["admin"]);
    assert.equal((await req(srv.base, "GET", endpoint, { anon: true })).status, 401);
    const other = await githubSignIn(srv.base, "reviewer");
    assert.equal((await req(srv.base, "GET", endpoint, { cookie: other.cookie })).status, 403);
    assert.equal((await req(srv.base, "POST", endpoint, { cookie: other.cookie, body: {} })).status, 403);

    const config = (await req(srv.base, "GET", endpoint)).json.config;
    assert.equal(config.target, "self");
    assert.equal((await req(srv.base, "POST", endpoint, { body: { ...config, days: 0 } })).status, 400);
    assert.equal((await req(srv.base, "POST", endpoint, { body: { ...config, tools: ["bogus"] } })).status, 400);
    assert.equal((await req(srv.base, "POST", endpoint, { body: { ...config, target: "reviewer" } })).status, 400);
    assert.equal((await req(srv.base, "POST", endpoint, { body: { ...config, extra: 1 } })).status, 400);
    assert.deepEqual((await req(srv.base, "GET", "/api/profiles", { anon: true })).json.profiles.map((p) => p.username), ["admin", "reviewer"]);

    const realDevice = await newDevice(srv.base, "real laptop");
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { key: realDevice.key, body: event() })).status, 200);
    const edited = { ...config, days: 3, events_per_day: 2, tools: ["codex", "opencode"], models: ["model-a"], input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0 };
    const generated = await req(srv.base, "POST", endpoint, { body: edited });
    assert.equal(generated.status, 200, generated.text);
    assert.equal(generated.json.events, 6);
    const username = generated.json.username;
    assert.equal(username, "admin");
    assert.deepEqual((await req(srv.base, "GET", "/api/profiles", { anon: true })).json.profiles.map((p) => p.username), ["admin", "reviewer"]);
    assert.equal((await req(srv.base, "GET", `/api/u/${username}`, { anon: true })).json.sample, true);
    const summary = (await req(srv.base, "GET", `/api/u/${username}/summary`, { anon: true })).json;
    assert.equal(summary.total.events, 7);
    assert.deepEqual(summary.total.by_tool.map((x) => x.name).sort(), ["claude-code", "codex", "opencode"]);
    assert.deepEqual((await req(srv.base, "GET", "/api/devices")).json.devices.map((d) => d.name), ["real laptop", "preview"]);
    const board = (await req(srv.base, "GET", "/api/leaderboard?days=all", { anon: true })).json;
    assert.equal(board.entries.find((entry) => entry.username === username).sample, true);
    assert.deepEqual((await req(srv.base, "GET", endpoint)).json.config, edited);

    await githubSignIn(srv.base, "admin");
    assert.equal((await req(srv.base, "GET", `/api/u/${username}/summary`, { anon: true })).json.total.events, 7);
    const changed = await req(srv.base, "POST", endpoint, { body: { ...edited, events_per_day: 1 } });
    assert.equal(changed.json.events, 3);
    assert.equal((await req(srv.base, "GET", `/api/u/${username}/summary`, { anon: true })).json.total.events, 4);

    const separate = await req(srv.base, "POST", endpoint, { body: { ...edited, target: "preview_user", events_per_day: 1 } });
    assert.equal(separate.status, 200, separate.text);
    assert.equal(separate.json.username, "preview-sample");
    assert.equal((await req(srv.base, "GET", "/api/u/admin/summary", { anon: true })).json.total.events, 1);
    assert.equal((await req(srv.base, "GET", "/api/u/admin", { anon: true })).json.sample, undefined);
    assert.equal((await req(srv.base, "GET", "/api/u/preview-sample/summary", { anon: true })).json.total.events, 3);
    assert.equal((await req(srv.base, "GET", "/api/devices")).json.devices.map((d) => d.name).includes("preview"), false);

    const back = await req(srv.base, "POST", endpoint, { body: { ...edited, events_per_day: 1 } });
    assert.equal(back.status, 200, back.text);
    assert.equal((await req(srv.base, "GET", "/api/u/admin/summary", { anon: true })).json.total.events, 4);
    assert.equal((await req(srv.base, "GET", "/api/u/preview-sample", { anon: true })).status, 404);
  } finally {
    await srv.stop();
  }
});

test("production has no sample controls or preview marker", async () => {
  const srv = await startServer();
  try {
    assert.equal((await req(srv.base, "GET", "/api/auth/status")).json.preview, undefined);
    assert.equal((await req(srv.base, "GET", "/api/admin/preview-seed")).status, 404);
    assert.equal((await req(srv.base, "POST", "/api/admin/preview-seed", { body: {} })).status, 404);
  } finally {
    await srv.stop();
  }
});

test("the installed preview Compose configuration enables the controls without PREVIEW_MODE", async () => {
  const srv = await startServer({ env: {
    PUBLIC_URL: "https://pr-206.ai-activity-preview.example",
    TRUST_PROXY: "172.29.95.0/24",
    ALLOWED_GITHUB_LOGINS: "admin",
  } });
  try {
    assert.equal((await req(srv.base, "GET", "/api/auth/status", { anon: true })).json.preview, true);
    assert.equal((await req(srv.base, "GET", "/api/admin/preview-seed")).status, 200);
  } finally {
    await srv.stop();
  }
});
