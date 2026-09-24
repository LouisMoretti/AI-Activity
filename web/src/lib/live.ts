// Maps measured API responses into the view model. Missing data stays
// "Unavailable" / "—"; nothing is interpolated.
import type {
  ActivityResponse, BillingResponse, Quota, QuotasResponse, SessionsResponse, StatsResponse,
} from "../../../shared/types.ts";
import { plural, fmtCompact, fmtDateTime, fmtMoney, fmtNum } from "./format.ts";
import { denseSeries, peak, streaks } from "./series.ts";
import {
  TOOL_META, toolsFor, type BillingCardVM, type DashboardVM, type Provider,
  type QuotaCardVM, type SessionVM, type StatVM,
} from "./view-model.ts";

export interface LiveData {
  stats: StatsResponse;
  activity: ActivityResponse;
  quotas: QuotasResponse;
  sessions: SessionsResponse;
  billing: BillingResponse;
}

export const STATS_DAYS = 30;
export const ACTIVITY_DAYS = 364;

function resetLabel(ts: number | null): string {
  if (!ts) return "Reset time not provided";
  const when = fmtDateTime(ts);
  return ts * 1000 < Date.now() ? `Window passed (${when})` : `Resets ${when}`;
}

function claudeQuotaCard(quotas: Quota[]): QuotaCardVM {
  const five = quotas.find((q) => q.tool === "claude-code" && q.limit_type === "five_hour");
  const seven = quotas.find((q) => q.tool === "claude-code" && q.limit_type === "seven_day");
  const measured = Math.max(five?.measured_at ?? 0, seven?.measured_at ?? 0);
  return {
    tool: "claude-code",
    name: "Claude Code",
    badge: measured ? `Last measured ${fmtDateTime(measured)}` : "No snapshot received yet",
    rows: [
      { label: "5-hour window", pct: five?.used_pct ?? null, reset: five ? resetLabel(five.resets_at) : "Unavailable" },
      { label: "This week", pct: seven?.used_pct ?? null, reset: seven ? resetLabel(seven.resets_at) : "Unavailable" },
    ],
  };
}

const codexUnavailable: QuotaCardVM = {
  tool: "codex",
  name: "Codex",
  badge: "Connector coming soon",
  rows: [
    { label: "5-hour window", pct: null, reset: "Unavailable" },
    { label: "This week", pct: null, reset: "Unavailable" },
  ],
};

function billingCards(b: BillingResponse): BillingCardVM[] {
  const subs = b.subscriptions;
  const actual = b.billing_records.filter((r) => r.kind === "api_actual");
  const paidTotal = subs.reduce((a, s) => a + Number(s.amount || 0), 0);
  const actualTotal = actual.reduce((a, r) => a + Number(r.amount || 0), 0);
  return [
    {
      title: "Paid subscriptions",
      value: subs.length ? fmtMoney(paidTotal, subs[0].currency) : "None recorded",
      note: subs.length
        ? subs.map((s) => `${s.tool} ${s.plan_name} — ${fmtMoney(s.amount, s.currency)}${s.note ? ` (${s.note})` : ""}`).join("\n")
        : "Enter what you actually paid (promotions and currency included) via POST /api/billing/subscription.",
    },
    {
      title: "Actual API charges",
      value: actual.length ? fmtMoney(actualTotal, actual[0].currency) : "None recorded",
      note: actual.length
        ? `${actual.length} provider invoice record(s).`
        : "Verified provider billing only. Empty until an invoice source is connected.",
    },
    {
      title: "Estimated API equivalent",
      value: fmtMoney(b.estimated_api_equivalent_usd),
      note: "Derived from measured tokens and list prices. Neither an invoice nor a saving.",
    },
  ];
}

export function liveDashboard(d: LiveData, provider: Provider): DashboardVM {
  const series = denseSeries(d.activity.days, ACTIVITY_DAYS);
  const hasData = d.stats.has_data || series.some((x) => x.tokens > 0);
  const s = streaks(series);
  const stats: StatVM[] = hasData
    ? [
      { value: fmtCompact(d.stats.total_tokens), label: `Tokens (${STATS_DAYS} d)` },
      { value: fmtNum(d.stats.sessions), label: `Sessions (${STATS_DAYS} d)` },
      { value: fmtCompact(peak(series)), label: "Busiest day (1 y)" },
      { value: plural(s.current, "day"), label: "Current streak" },
      { value: plural(s.longest, "day"), label: "Longest streak (1 y)" },
    ]
    : ["Tokens", "Sessions", "Busiest day", "Current streak", "Longest streak"]
      .map((label) => ({ value: "—", label }));

  const sessions: SessionVM[] = d.sessions.sessions
    .filter((x) => provider === "all" || x.tool === provider)
    .map((x) => ({
      tool: x.tool === "codex" ? "codex" : "claude-code",
      title: `${TOOL_META[x.tool === "codex" ? "codex" : "claude-code"].name} · ${x.session_id.slice(0, 8)}…`,
      subtitle: `${x.model || "model not reported"} · ${x.events} events · last seen ${fmtDateTime(x.last_seen)}`,
      tokensLabel: `${fmtCompact(x.tokens)} tokens (summed increments)`,
      context: null, // context window size is not ingested yet
    }));

  return {
    demo: false,
    periodLabel: `Last ${STATS_DAYS} days · measured data`,
    stats,
    series,
    hasActivity: hasData,
    quotas: toolsFor(provider).map((t) => (t === "codex" ? codexUnavailable : claudeQuotaCard(d.quotas.quotas))),
    sessions,
    sessionsSubtitle: "Recent measured sessions",
    billing: billingCards(d.billing),
    footer: "Measured data from your devices. No prompts or transcripts are ever transmitted.",
  };
}
