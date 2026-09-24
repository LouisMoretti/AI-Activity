// FICTIONAL, deterministic demo dataset. Only reachable via ?demo=1 and
// always labeled "Demonstration data". Never presented as a measurement.
import { plural, fmtCompact } from "./format.ts";
import { peak, streaks, type DayPoint } from "./series.ts";
import { toolsFor, type DashboardVM, type Provider, type ToolKey } from "./view-model.ts";

const days = Array.from({ length: 364 }, (_, i) => {
  const day = new Date(Date.UTC(2025, 9, 1 + i)).toISOString().slice(0, 10);
  const active = i > 200 ? ((i * 37) % 13) > 3 : ((i * 19) % 71) < 2;
  return {
    day,
    codex: active ? Math.round(((i * 7919) % 1600000) * (i > 290 ? 2 : 1)) : 0,
    "claude-code": active && i % 3 !== 0 ? Math.round((i * 3571) % 1200000) : 0,
  };
});

const quota = {
  codex: { plan: "Plus · demo", five: 38, week: 64, reset: "Resets in 2 h 18 min", weekly: "Monday at 09:00" },
  "claude-code": { plan: "Pro · demo", five: 72, week: 86, reset: "Resets in 48 min", weekly: "Friday at 14:30" },
};

const sessions = [
  { tool: "codex" as ToolKey, title: "Consumption dashboard", used: 74000, max: 258000 },
  { tool: "claude-code" as ToolKey, title: "API and sync", used: 128000, max: 200000 },
];

export function demoDashboard(provider: Provider): DashboardVM {
  const tools = toolsFor(provider);
  const series: DayPoint[] = days.map((d) => ({
    day: d.day,
    tokens: tools.reduce((a, t) => a + d[t], 0),
  }));
  const s = streaks(series);
  return {
    demo: true,
    periodLabel: "Oct. 2025 — Sept. 2026 · fictional data",
    stats: [
      { value: fmtCompact(series.reduce((a, d) => a + d.tokens, 0)), label: "Tokens (1 y)" },
      { value: fmtCompact(peak(series)), label: "Busiest day" },
      { value: provider === "claude-code" ? "1 h 52 min" : "2 h 44 min", label: "Longest chat" },
      { value: plural(s.current, "day"), label: "Current streak" },
      { value: plural(s.longest, "day"), label: "Longest streak" },
    ],
    series,
    hasActivity: true,
    quotas: tools.map((t) => ({
      tool: t,
      name: t === "codex" ? "Codex" : "Claude Code",
      badge: quota[t].plan,
      rows: [
        { label: "5-hour window", pct: quota[t].five, reset: quota[t].reset },
        { label: "This week", pct: quota[t].week, reset: quota[t].weekly },
      ],
    })),
    sessions: sessions.filter((x) => tools.includes(x.tool)).map((x) => ({
      tool: x.tool,
      title: x.title,
      subtitle: `${x.tool === "codex" ? "Codex" : "Claude Code"} · fictional conversation`,
      tokensLabel: `${fmtCompact(x.used)} / ${fmtCompact(x.max)} tokens`,
      context: { used: x.used, max: x.max },
    })),
    sessionsSubtitle: "Last simulated state — fictional",
    billing: [
      { title: "Paid subscriptions", value: "Demo", note: "Manually entered — fictional." },
      { title: "Actual API charges", value: "Demo", note: "Provider invoices — fictional." },
      { title: "Estimated API equivalent", value: "Demo", note: "Derived from tokens — neither an invoice nor a saving." },
    ],
    footer: "Demo mode: no account connection, no real quotas. Fictional values.",
  };
}
