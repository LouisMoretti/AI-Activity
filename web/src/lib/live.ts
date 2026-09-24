// Maps measured API responses into the view model. Missing data stays
// null ("—" / "Unavailable"); nothing is interpolated.
import type {
  ActivityResponse, BillingResponse, Breakdown, QuotasResponse, SessionsResponse, SummaryResponse,
} from "../../../shared/types.ts";
import { fmtMoney, fmtMoneyTotals } from "./format.ts";
import { denseSeries, streaks } from "./series.ts";
import {
  toolsFor, WINDOW_SPANS, type CostCardVM, type DashboardVM, type FigureVM, type Provider,
  type QuotaToolVM, type SessionVM, type ToolKey,
} from "./view-model.ts";

export interface LiveData {
  summary: SummaryResponse;
  activity: ActivityResponse;
  quotas: QuotasResponse;
  sessions: SessionsResponse;
  /** Only for the viewer's own profile: costs are private. */
  billing: BillingResponse | null;
}

export const ACTIVITY_DAYS = 364;

function figure(b: Breakdown, metric: "tokens" | "sessions"): FigureVM {
  const has = b.events > 0;
  return {
    value: has ? b[metric] : null,
    byTool: b.by_tool.map((r) => ({ name: r.name, value: r[metric] })),
    byModel: b.by_model.map((r) => ({ name: r.name, value: r[metric] })),
  };
}

function claudeQuotas(q: QuotasResponse): QuotaToolVM {
  const find = (type: keyof typeof WINDOW_SPANS) =>
    q.quotas.find((x) => x.tool === "claude-code" && x.limit_type === type);
  const five = find("five_hour");
  const week = find("seven_day");
  const updated = Math.max(five?.measured_at ?? 0, week?.measured_at ?? 0);
  return {
    tool: "claude-code",
    connected: true,
    updatedAt: updated || null,
    windows: [
      { label: "5-hour window", pct: five?.used_pct ?? null, resetsAt: five?.resets_at ?? null, spanSec: WINDOW_SPANS.five_hour },
      { label: "This week", pct: week?.used_pct ?? null, resetsAt: week?.resets_at ?? null, spanSec: WINDOW_SPANS.seven_day },
    ],
  };
}

const codexNotConnected: QuotaToolVM = {
  tool: "codex",
  connected: false,
  updatedAt: null,
  windows: [
    { label: "5-hour window", pct: null, resetsAt: null, spanSec: WINDOW_SPANS.five_hour },
    { label: "This week", pct: null, resetsAt: null, spanSec: WINDOW_SPANS.seven_day },
  ],
};

function costCards(b: BillingResponse): CostCardVM[] {
  const subs = b.subscriptions;
  const actual = b.billing_records.filter((r) => r.kind === "api_actual");
  return [
    {
      label: "Paid subscriptions",
      value: subs.length ? fmtMoneyTotals(subs) : null,
      note: subs.length
        ? subs.map((s) => `${s.plan_name} · ${fmtMoney(s.amount, s.currency)}`).join(", ")
        : "Add what you actually paid, including promotions and currency.",
    },
    {
      label: "Actual API charges",
      value: actual.length ? fmtMoneyTotals(actual) : null,
      note: actual.length
        ? `${actual.length} provider invoice record(s).`
        : "Provider invoices only. Empty until an invoice source is connected.",
    },
    {
      label: "API-rate estimate",
      value: b.estimated_available ? fmtMoney(b.estimated_api_equivalent_usd) : null,
      note: b.estimated_available
        ? "From measured tokens at list prices. Neither an invoice nor a saving."
        : "No cost data received yet. Neither an invoice nor a saving.",
    },
  ];
}

const asTool = (t: string): ToolKey =>
  t === "codex" || t === "opencode" ? t : "claude-code";

export function liveDashboard(d: LiveData, provider: Provider): DashboardVM {
  const series = denseSeries(d.activity.days, ACTIVITY_DAYS);
  const hasActivity = d.summary.total.events > 0;
  const sessions: SessionVM[] = d.sessions.sessions.map((s) => ({
    tool: asTool(s.tool),
    id: s.session_id,
    model: s.model,
    calls: s.events,
    tokens: s.tokens,
    lastActive: s.last_seen,
    context: s.context_used_pct === null ? null : { pct: s.context_used_pct, size: s.context_window_size },
  }));
  return {
    demo: false,
    today: d.summary.day,
    series,
    hasActivity,
    stats: {
      total: figure(d.summary.total, "tokens"),
      today: figure(d.summary.today, "tokens"),
      sessions: figure(d.summary.total, "sessions"),
      streak: hasActivity ? streaks(series) : null,
    },
    tools: toolsFor(provider),
    claude: claudeQuotas(d.quotas),
    codex: codexNotConnected,
    sessions,
    sessionsTotal: d.sessions.total,
    cost: d.billing ? costCards(d.billing) : null,
  };
}
