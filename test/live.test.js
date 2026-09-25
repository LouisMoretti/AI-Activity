import { test } from "node:test";
import assert from "node:assert/strict";
import { liveDashboard } from "../web/src/lib/live.ts";

const breakdown = { tokens: 0, sessions: 0, events: 0, by_model: [], by_tool: [] };
const data = (quotas) => ({
  summary: { day: "2026-09-25", total: breakdown, today: breakdown },
  activity: { days: [] },
  quotas: { quotas },
  sessions: { sessions: [], total: 0 },
  opencode: { day: "2026-09-25", total: breakdown, today: breakdown },
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

test("OpenCode usage is split by provider; none yet is null, not zero", () => {
  assert.deepEqual(liveDashboard(data([]), "all").opencode, { tokens: null, today: null, sessions: null, providers: [] });
  const row = (name, tokens) => ({ name, tokens, sessions: 1, events: 1 });
  const d = data([]);
  d.opencode = { day: "2026-09-25",
    total: { tokens: 650, sessions: 3, events: 4, by_tool: [], by_model: [row("opencode/muse", 100), row("anthropic/claude-sonnet-5", 300), row("opencode/free", 250)] },
    today: { tokens: 0, sessions: 0, events: 0, by_tool: [], by_model: [] } };
  const vm = liveDashboard(d, "all").opencode;
  assert.deepEqual(vm, { tokens: 650, today: 0, sessions: 3,
    providers: [{ name: "opencode", value: 350 }, { name: "anthropic", value: 300 }] });
});
