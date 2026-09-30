import { test } from "node:test";
import assert from "node:assert/strict";
import { liveDashboard } from "../web/src/lib/live.ts";
import { hasLiveWindow } from "../web/src/lib/view-model.ts";

const breakdown = { tokens: 0, sessions: 0, events: 0, by_model: [], by_model_others_sessions: 0, by_tool: [] };
const data = (quotas) => ({
  summary: { day: "2026-09-25", total: breakdown, today: breakdown },
  activity: { days: [] },
  quotas: { quotas },
  sessions: { sessions: [], total: 0 },
  opencode: { summary: { day: "2026-09-25", total: breakdown, today: breakdown }, latest: { sessions: [], total: 0 } },
  antigravity: { summary: { day: "2026-09-25", total: breakdown, today: breakdown }, latest: { sessions: [], total: 0 } },
  cursor: { summary: { day: "2026-09-25", total: breakdown, today: breakdown }, latest: { sessions: [], total: 0 } },
});
const q = (tool, limit_type, used_pct, measured_at) =>
  ({ account_ref: "default", tool, limit_type, used_pct, resets_at: measured_at + 3600, measured_at });

test("Cursor's activity card keeps measured usage and identity without inventing quotas or providers", () => {
  const d = data([]);
  const session = { tool: "cursor", session_id: "cursor:conv1", model: "composer-2.5", events: 2, tokens: 1080,
    last_seen: 1790000000, context_used_pct: null, context_window_size: null };
  d.cursor = { summary: { ...d.summary, today: { ...breakdown, tokens: 1080, sessions: 1, events: 2,
    by_model: [{ name: "composer-2.5", tokens: 1080 }] } }, latest: { sessions: [session], total: 1 } };
  d.sessions = { sessions: [session], total: 1 };
  const vm = liveDashboard(d, "all");
  assert.deepEqual(vm.tools, ["claude-code", "codex", "cursor", "antigravity", "opencode"]);
  assert.deepEqual(vm.cursor.today, { tokens: 1080, sessions: 1, calls: 2, models: 1, providers: null });
  assert.equal(vm.cursor.recent[0].id, "conv1");
  assert.equal(vm.sessions[0].tool, "cursor");
  assert.equal(vm.sessions[0].context, null);
  assert.ok(!("pools" in vm.cursor), "the Cursor card has no quota pools");
  assert.deepEqual(liveDashboard(data([]), "all").cursor.recent, []);
});

test("a caller built before Cursor support gets an empty Cursor card, not a crash", () => {
  const d = data([]);
  delete d.cursor;
  const vm = liveDashboard(d, "all");
  assert.deepEqual(vm.cursor, { recent: [], today: { tokens: 0, sessions: 0, calls: 0, models: 0, providers: null } });
});

test("each tool card shows its own quota windows, never another tool's", () => {
  const vm = liveDashboard(data([
    q("claude-code", "five_hour", 20, 100), q("codex", "five_hour", 17, 200), q("codex", "seven_day", 75, 300),
  ]), "all");
  assert.deepEqual(vm.claude.pools.map((p) => p.label), [null]);
  assert.deepEqual(vm.claude.pools[0].windows.map((w) => w.pct), [20, null]);
  assert.deepEqual(vm.codex.pools[0].windows.map((w) => w.pct), [17, 75]);
  assert.equal(vm.codex.updatedAt, 300);
});

test("no Codex snapshot yet: Unavailable, not zero", () => {
  const vm = liveDashboard(data([]), "all");
  assert.equal(vm.codex.updatedAt, null);
  assert.deepEqual(vm.codex.pools[0].windows.map((w) => [w.label, w.pct]), [["5-hour window", null], ["This week", null]]);
});

test("the OpenCode card gets its latest conversations and today; none yet is empty", () => {
  assert.deepEqual(liveDashboard(data([]), "all").opencode.recent, []);
  const d = data([]);
  d.opencode = {
    summary: { day: "2026-09-25", total: breakdown, today: { ...breakdown, tokens: 5500, sessions: 4, events: 9,
      by_model: [{ name: "opencode/muse", tokens: 5000 }, { name: "opencode/free", tokens: 300 }, { name: "agentrouter/glm-5.3", tokens: 200 }] } },
    latest: { total: 12, sessions: [{ tool: "opencode", session_id: "ses_1", model: "opencode/muse", events: 42, tokens: 1200,
      last_seen: 1790000000, context_used_pct: null, context_window_size: null }] },
  };
  const vm = liveDashboard(d, "all").opencode;
  assert.deepEqual(vm.today, { tokens: 5500, sessions: 4, calls: 9, models: 3, providers: 2 });
  assert.deepEqual(vm.recent[0], { tool: "opencode", id: "ses_1", model: "opencode/muse", calls: 42, tokens: 1200, lastActive: 1790000000, context: null });
});

test("the sessions figure keeps the server's exact folded-model session count", () => {
  const d = data([]);
  d.summary = {
    day: "2026-09-25",
    total: {
      ...breakdown,
      sessions: 24,
      events: 1,
      by_model_others_sessions: 3,
      by_model: Array.from({ length: 9 }, (_, i) => ({ name: `model-${i}`, tokens: 9 - i, sessions: 3, events: 1 })),
    },
    today: breakdown,
  };
  assert.equal(liveDashboard(d, "all").stats.sessions.byModelOthers, 3);
});


test("Antigravity keeps its identity in sessions, cards and token breakdowns", () => {
  const d = data([]);
  const session = { tool: "antigravity", session_id: "antigravity:abc", model: null, events: 2, tokens: 500,
    last_seen: 1790000000, context_used_pct: null, context_window_size: null };
  d.sessions = { sessions: [session], total: 1 };
  const vm = liveDashboard(d, "all");
  assert.ok(vm.tools.includes("antigravity"));
  assert.equal(vm.sessions[0].tool, "antigravity");
  assert.equal(vm.sessions[0].id, "abc"); // shown without the storage prefix
  assert.equal(vm.sessions[0].context, null);
  assert.equal(vm.sessions[0].model, null);
  assert.equal(vm.antigravity.updatedAt, null);
  assert.deepEqual(vm.antigravity.pools.map((p) => p.windows.map((w) => w.pct)), [[null, null], [null, null]]);
  assert.equal(vm.opencode.today.tokens, 0);
});

test("Antigravity quota pools keep their own usage, resets and missing windows", () => {
  const gemini = { ...q("antigravity", "five_hour", 25, 500), account_ref: "gemini" };
  const thirdParty = { ...q("antigravity", "seven_day", 70, 600), account_ref: "claude-gpt", resets_at: 70000 };
  const vm = liveDashboard(data([thirdParty, gemini, q("codex", "five_hour", 90, 700)]), "all");
  assert.equal(vm.antigravity.updatedAt, 600);
  assert.deepEqual(vm.antigravity.pools.map((p) => p.label), ["Gemini", "Claude/GPT"]);
  assert.deepEqual(vm.antigravity.pools.map((p) => p.windows.map((w) => [w.pct, w.resetsAt, w.spanSec])),
    [[[25, 4100, 18000], [null, null, 604800]], [[null, null, 18000], [70, 70000, 604800]]]);
});


test("quota card update time ignores unrendered pools and limit types", () => {
  const vm = liveDashboard(data([
    { ...q("antigravity", "five_hour", 25, 500), account_ref: "gemini" },
    { ...q("antigravity", "five_hour", 80, 999), account_ref: "default" },
    { ...q("antigravity", "custom", 80, 999), account_ref: "gemini" },
  ]), "all");
  assert.equal(vm.antigravity.updatedAt, 500);
  assert.deepEqual(vm.antigravity.pools.map((p) => p.windows.map((w) => w.pct)), [[25, null], [null, null]]);
});

test("Antigravity falls back to its activity card while no quota window is running", () => {
  const d = data([]);
  d.antigravity = {
    summary: { day: "2026-09-25", total: breakdown,
      today: { tokens: 900, sessions: 1, events: 3, by_model: [{ name: "gemini-3.5-flash", tokens: 900 }], by_tool: [] } },
    latest: { total: 1, sessions: [{ tool: "antigravity", session_id: "antigravity:abc", model: "gemini-3.5-flash", events: 3,
      tokens: 900, first_seen: 1790000000, last_seen: 1790000100, context_used_pct: null, context_window_size: null }] },
  };
  const vm = liveDashboard(d, "all");
  assert.equal(hasLiveWindow(vm.antigravity, 1790000000), false);
  assert.deepEqual(vm.antigravityActivity.today, { tokens: 900, sessions: 1, calls: 3, models: 1, providers: null });
  assert.equal(vm.antigravityActivity.recent[0].id, "abc");
  const withQuota = liveDashboard(data([{ ...q("antigravity", "five_hour", 25, 500), account_ref: "gemini" }]), "all");
  assert.equal(hasLiveWindow(withQuota.antigravity, 600), true);
  assert.equal(hasLiveWindow(withQuota.antigravity, 500 + 3600), false, "an expired window no longer counts");
});
