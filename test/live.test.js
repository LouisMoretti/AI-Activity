import { test } from "node:test";
import assert from "node:assert/strict";
import { liveDashboard } from "../web/src/lib/live.ts";

const breakdown = { tokens: 0, sessions: 0, events: 0, by_model: [], by_tool: [] };
const data = (quotas) => ({
  summary: { day: "2026-09-25", total: breakdown, today: breakdown },
  activity: { days: [] },
  quotas: { quotas },
  sessions: { sessions: [], total: 0 },
  opencode: { summary: { day: "2026-09-25", total: breakdown, today: breakdown }, latest: { sessions: [], total: 0 } },
  antigravity: { summary: { day: "2026-09-25", total: breakdown, today: breakdown }, latest: { sessions: [], total: 0 } },
});
const q = (tool, limit_type, used_pct, measured_at) =>
  ({ account_ref: "default", tool, limit_type, used_pct, resets_at: measured_at + 3600, measured_at });

test("each tool card shows its own quota windows, never another tool's", () => {
  const vm = liveDashboard(data([
    q("claude-code", "five_hour", 20, 100), q("codex", "five_hour", 17, 200), q("codex", "seven_day", 75, 300),
  ]), "all");
  assert.deepEqual(vm.claude.windows.map((w) => w.pct), [20, null]);
  assert.deepEqual(vm.codex.windows.map((w) => w.pct), [17, 75]);
  assert.equal(vm.codex.updatedAt, 300);
});

test("no Codex snapshot yet: Unavailable, not zero", () => {
  const vm = liveDashboard(data([]), "all");
  assert.equal(vm.codex.updatedAt, null);
  assert.deepEqual(vm.codex.windows.map((w) => w.pct), [null, null]);
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


test("Antigravity keeps its identity in sessions, cards and token breakdowns", () => {
  const d = data([]);
  const session = { tool: "antigravity", session_id: "antigravity:abc", model: null, events: 2, tokens: 500,
    last_seen: 1790000000, context_used_pct: null, context_window_size: null };
  d.sessions = { sessions: [session], total: 1 };
  d.antigravity = { summary: { day: "2026-09-25", total: breakdown,
    today: { ...breakdown, tokens: 500, sessions: 1, events: 2 } }, latest: d.sessions };
  const vm = liveDashboard(d, "all");
  assert.ok(vm.tools.includes("antigravity"));
  assert.equal(vm.sessions[0].tool, "antigravity");
  assert.equal(vm.antigravity.recent[0].context, null);
  assert.equal(vm.antigravity.recent[0].model, null);
  assert.equal(vm.antigravity.today.tokens, 500);
  assert.equal(vm.opencode.today.tokens, 0);
});
