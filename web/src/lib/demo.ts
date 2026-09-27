// FICTIONAL, deterministic demo dataset. Only reachable via ?demo=1 and
// always labeled "Demonstration data". Never presented as a measurement.
import { QUOTA_WINDOW_SEC } from "../../../shared/quota-pools.ts";
import { lastUtcDays, streaks, type DayPoint } from "./series.ts";
import {
  POOL_LABELS, toolsFor, WINDOW_LABELS, type DashboardVM, type FigureVM, type Provider,
  type QuotaPoolVM, type SessionVM,
} from "./view-model.ts";

type DemoTool = "claude-code" | "codex" | "antigravity";
const DEMO_TOOLS: DemoTool[] = ["claude-code", "codex", "antigravity"];
const MODELS: Record<DemoTool, [string, number][]> = {
  "claude-code": [["claude-opus-5-5", 0.7], ["claude-sonnet-5", 0.3]],
  codex: [["gpt-5-codex", 1]],
  antigravity: [["gemini-3.5-flash", 0.7], ["claude-sonnet-5", 0.3]],
};

// Deterministic pseudo-activity, anchored on today so the calendar is full.
const days = lastUtcDays(364).map((day, i) => {
  const active = i >= 358 || (i > 200 ? ((i * 37) % 13) > 3 : ((i * 19) % 71) < 2);
  return {
    day,
    codex: active ? Math.round(((i * 7919) % 1600000) * (i > 290 ? 2 : 1)) : 0,
    "claude-code": active && i % 3 !== 0 ? Math.round((i * 3571) % 1200000) : 0,
    antigravity: active && i > 290 ? Math.round((i * 4567) % 900000) : 0,
  };
});

function figure(tools: DemoTool[], pick: (t: DemoTool) => number): FigureVM {
  const byTool = tools.map((t) => ({ name: t, value: pick(t) })).filter((r) => r.value > 0);
  // A model can be used by more than one tool. Like the live API, combine
  // those values before rendering lists keyed by model name.
  const models = new Map<string, number>();
  for (const t of tools) {
    for (const [model, share] of MODELS[t]) {
      models.set(model, (models.get(model) ?? 0) + Math.round(pick(t) * share));
    }
  }
  const byModel = [...models].map(([name, value]) => ({ name, value }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  return { value: byTool.reduce((a, r) => a + r.value, 0), byTool, byModel };
}

// A pool's 5-hour and weekly windows: [% used, reset time] each.
function pool(label: string | null, five: [number, number], week: [number, number]): QuotaPoolVM {
  return {
    label,
    windows: [
      { label: WINDOW_LABELS.five_hour, pct: five[0], resetsAt: five[1], spanSec: QUOTA_WINDOW_SEC.five_hour },
      { label: WINDOW_LABELS.seven_day, pct: week[0], resetsAt: week[1], spanSec: QUOTA_WINDOW_SEC.seven_day },
    ],
  };
}

export function demoDashboard(provider: Provider): DashboardVM {
  const visible = toolsFor(provider);
  const tools = DEMO_TOOLS.filter((t) => visible.includes(t));
  const series: DayPoint[] = days.map((d) => ({ day: d.day, tokens: tools.reduce((a, t) => a + d[t], 0) }));
  const now = Math.floor(Date.now() / 1000);
  const last = days[days.length - 1];

  const sessions: SessionVM[] = ([
    { tool: "claude-code", id: "demo-a1b2c3d4", model: "claude-opus-5-5", calls: 142, tokens: 18_400_000, lastActive: now - 90, context: { pct: 64, size: 200000 } },
    { tool: "antigravity", id: "demo-g7h8i9j0", model: "gemini-3.5-flash", calls: 24, tokens: 420_000, lastActive: now - 3 * 60, context: null },
    { tool: "codex", id: "demo-e5f6a7b8", model: "gpt-5-codex", calls: 57, tokens: 6_100_000, lastActive: now - 25 * 60, context: { pct: 29, size: 258000 } },
    { tool: "claude-code", id: "demo-c9d0e1f2", model: "claude-sonnet-5", calls: 12, tokens: 940_000, lastActive: now - 5 * 3600, context: null },
    { tool: "antigravity", id: "demo-k1l2m3n4", model: "claude-sonnet-5", calls: 9, tokens: 180_000, lastActive: now - 9 * 3600, context: null },
    { tool: "opencode", id: "demo-o5p6q7r8", model: "openai/gpt-5.2", calls: 18, tokens: 760_000, lastActive: now - 2 * 86400, context: null },
  ] satisfies SessionVM[]).filter((s) => visible.includes(s.tool));

  return {
    demo: true,
    today: last.day,
    series,
    hasActivity: true,
    stats: {
      total: figure(tools, (t) => days.reduce((a, d) => a + d[t], 0)),
      today: figure(tools, (t) => last[t]),
      sessions: figure(tools, (t) => ({ "claude-code": 64, codex: 38, antigravity: 18 })[t]),
      streak: streaks(series),
    },
    tools: visible,
    claude: {
      tool: "claude-code",
      updatedAt: now - 40,
      pools: [pool(null, [72, now + 48 * 60], [86, now + 2 * 86400 + 5 * 3600])],
    },
    codex: {
      tool: "codex",
      updatedAt: now - 20 * 60,
      pools: [pool(null, [38, now + 2 * 3600 + 18 * 60], [64, now + 4 * 86400])],
    },
    // Exercise the state where history exists but the tool was not used today.
    opencode: {
      recent: sessions.filter((s) => s.tool === "opencode"),
      today: { tokens: 0, sessions: 0, calls: 0, models: 0, providers: 0 },
    },
    antigravity: {
      tool: "antigravity",
      updatedAt: now - 60,
      pools: [
        pool(POOL_LABELS.gemini, [42, now + 2 * 3600 + 40 * 60], [68, now + 3 * 86400 + 7 * 3600]),
        pool(POOL_LABELS["claude-gpt"], [19, now + 4 * 3600 + 10 * 60], [32, now + 5 * 86400]),
      ],
    },
    // Shown only if the fictional quota windows above were all over.
    antigravityActivity: {
      recent: sessions.filter((s) => s.tool === "antigravity"),
      today: { tokens: last.antigravity, sessions: 1, calls: 24, models: 1, providers: null },
    },
    sessions,
    sessionsTotal: sessions.length,
  };
}
