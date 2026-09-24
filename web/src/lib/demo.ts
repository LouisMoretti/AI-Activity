// FICTIONAL, deterministic demo dataset. Only reachable via ?demo=1 and
// always labeled "Demonstration data". Never presented as a measurement.
import { lastUtcDays, streaks, type DayPoint } from "./series.ts";
import {
  toolsFor, WINDOW_SPANS, type DashboardVM, type FigureVM, type Provider, type SessionVM,
} from "./view-model.ts";

type DemoTool = "claude-code" | "codex";
const DEMO_TOOLS: DemoTool[] = ["claude-code", "codex"];
const MODELS: Record<DemoTool, [string, number][]> = {
  "claude-code": [["claude-opus-5-5", 0.7], ["claude-sonnet-5", 0.3]],
  codex: [["gpt-5-codex", 1]],
};

// Deterministic pseudo-activity, anchored on today so the calendar is full.
const days = lastUtcDays(364).map((day, i) => {
  const active = i >= 358 || (i > 200 ? ((i * 37) % 13) > 3 : ((i * 19) % 71) < 2);
  return {
    day,
    codex: active ? Math.round(((i * 7919) % 1600000) * (i > 290 ? 2 : 1)) : 0,
    "claude-code": active && i % 3 !== 0 ? Math.round((i * 3571) % 1200000) : 0,
  };
});

function figure(tools: DemoTool[], pick: (t: DemoTool) => number): FigureVM {
  const byTool = tools.map((t) => ({ name: t, value: pick(t) })).filter((r) => r.value > 0);
  const byModel = tools.flatMap((t) => MODELS[t].map(([m, share]) => ({ name: m, value: Math.round(pick(t) * share) })))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  return { value: byTool.reduce((a, r) => a + r.value, 0), byTool, byModel };
}

export function demoDashboard(provider: Provider): DashboardVM {
  const visible = toolsFor(provider);
  const tools = DEMO_TOOLS.filter((t) => visible.includes(t));
  const series: DayPoint[] = days.map((d) => ({ day: d.day, tokens: tools.reduce((a, t) => a + d[t], 0) }));
  const now = Math.floor(Date.now() / 1000);
  const last = days[days.length - 1];

  const sessions: SessionVM[] = ([
    { tool: "claude-code", id: "demo-a1b2c3d4", model: "claude-opus-5-5", calls: 142, tokens: 18_400_000, lastActive: now - 90, context: { pct: 64, size: 200000 } },
    { tool: "codex", id: "demo-e5f6a7b8", model: "gpt-5-codex", calls: 57, tokens: 6_100_000, lastActive: now - 25 * 60, context: { pct: 29, size: 258000 } },
    { tool: "claude-code", id: "demo-c9d0e1f2", model: "claude-sonnet-5", calls: 12, tokens: 940_000, lastActive: now - 5 * 3600, context: null },
  ] satisfies SessionVM[]).filter((s) => visible.includes(s.tool));

  return {
    demo: true,
    today: last.day,
    series,
    hasActivity: true,
    stats: {
      total: figure(tools, (t) => days.reduce((a, d) => a + d[t], 0)),
      today: figure(tools, (t) => last[t]),
      sessions: figure(tools, (t) => (t === "codex" ? 38 : 64)),
      streak: streaks(series),
    },
    tools: visible,
    claude: {
      tool: "claude-code",
      connected: true,
      updatedAt: now - 40,
      windows: [
        { label: "5-hour window", pct: 72, resetsAt: now + 48 * 60, spanSec: WINDOW_SPANS.five_hour },
        { label: "This week", pct: 86, resetsAt: now + 2 * 86400 + 5 * 3600, spanSec: WINDOW_SPANS.seven_day },
      ],
    },
    codex: {
      tool: "codex",
      connected: true,
      updatedAt: now - 20 * 60,
      windows: [
        { label: "5-hour window", pct: 38, resetsAt: now + 2 * 3600 + 18 * 60, spanSec: WINDOW_SPANS.five_hour },
        { label: "This week", pct: 64, resetsAt: now + 4 * 86400, spanSec: WINDOW_SPANS.seven_day },
      ],
    },
    sessions,
    sessionsTotal: sessions.length,
    cost: [
      { label: "Paid subscriptions", value: "Demo", note: "Manually entered. Fictional." },
      { label: "Actual API charges", value: "Demo", note: "Provider invoices. Fictional." },
      { label: "API-rate estimate", value: "Demo", note: "Neither an invoice nor a saving. Fictional." },
    ],
  };
}
