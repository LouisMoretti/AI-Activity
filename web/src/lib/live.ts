// Maps measured API responses into the view model. Missing data stays
// null ("—" / "Unavailable"); nothing is interpolated.
import type {
  ActivityResponse, Breakdown, QuotasResponse, SessionsResponse, SummaryResponse,
} from "../../../shared/types.ts";
import { denseSeries, streaks } from "./series.ts";
import {
  toolsFor, WINDOW_SPANS, type DashboardVM, type FigureVM, type Provider,
  type QuotaToolVM, type SessionVM, type ToolKey,
} from "./view-model.ts";

export interface LiveData {
  summary: SummaryResponse;
  activity: ActivityResponse;
  quotas: QuotasResponse;
  sessions: SessionsResponse;
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

function toolQuotas(q: QuotasResponse, tool: QuotaToolVM["tool"]): QuotaToolVM {
  const find = (type: keyof typeof WINDOW_SPANS) =>
    q.quotas.find((x) => x.tool === tool && x.limit_type === type);
  const five = find("five_hour");
  const week = find("seven_day");
  const updated = Math.max(five?.measured_at ?? 0, week?.measured_at ?? 0);
  return {
    tool,
    updatedAt: updated || null,
    windows: [
      { label: "5-hour window", pct: five?.used_pct ?? null, resetsAt: five?.resets_at ?? null, spanSec: WINDOW_SPANS.five_hour },
      { label: "This week", pct: week?.used_pct ?? null, resetsAt: week?.resets_at ?? null, spanSec: WINDOW_SPANS.seven_day },
    ],
  };
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
    claude: toolQuotas(d.quotas, "claude-code"),
    codex: toolQuotas(d.quotas, "codex"),
    sessions,
    sessionsTotal: d.sessions.total,
  };
}
