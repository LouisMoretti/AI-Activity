import { QUOTA_POOLS } from "../../../shared/quota-pools.ts";
// Maps measured API responses into the view model. Missing data stays
// null ("—" / "Unavailable"); nothing is interpolated.
import type {
  ActivityResponse, Breakdown, QuotasResponse, Session, SessionsResponse, SummaryResponse,
} from "../../../shared/types.ts";
import { denseSeries, streaks } from "./series.ts";
import {
  toolsFor, WINDOW_SPANS, type DashboardVM, type FigureVM, type Provider,
  type ActivityToolVM, type QuotaToolVM, type SessionVM, type ToolKey,
} from "./view-model.ts";

export interface LiveData {
  summary: SummaryResponse;
  activity: ActivityResponse;
  quotas: QuotasResponse;
  sessions: SessionsResponse;
  /** OpenCode's card: its summary (today) and its latest sessions. */
  opencode: { summary: SummaryResponse; latest: SessionsResponse };
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

const WINDOWS = [["five_hour", "5-hour window"], ["seven_day", "This week"]] as const;

function toolQuotas(q: QuotasResponse, tool: QuotaToolVM["tool"]): QuotaToolVM {
  const pools: readonly { ref: string | null; label: string }[] =
    tool in QUOTA_POOLS ? QUOTA_POOLS[tool as keyof typeof QUOTA_POOLS] : [{ ref: null, label: "" }];
  const rows = q.quotas.filter((x) => x.tool === tool);
  const used: typeof rows = [];
  const windows = pools.flatMap((pool) => WINDOWS.map(([type, label]) => {
    const row = rows.find((x) => x.limit_type === type && (pool.ref === null || x.account_ref === pool.ref));
    if (row) used.push(row);
    return { label: pool.label + label, pct: row?.used_pct ?? null,
      resetsAt: row?.resets_at ?? null, spanSec: WINDOW_SPANS[type] };
  }));
  return { tool, updatedAt: Math.max(0, ...used.map((x) => x.measured_at)) || null, windows };
}

const asTool = (t: string): ToolKey =>
  t === "codex" || t === "opencode" || t === "antigravity" ? t : "claude-code";

const toSession = (s: Session): SessionVM => ({
  tool: asTool(s.tool),
  id: s.session_id,
  model: s.model,
  calls: s.events,
  tokens: s.tokens,
  lastActive: s.last_seen,
  context: s.context_used_pct === null ? null : { pct: s.context_used_pct, size: s.context_window_size },
});

/** providers: the tool stores its models as provider/model (OpenCode). */
function activityTool(d: LiveData["opencode"], providers: boolean): ActivityToolVM {
  const t = d.summary.today;
  return {
    recent: d.latest.sessions.map(toSession),
    today: {
      tokens: t.tokens, sessions: t.sessions, calls: t.events, models: t.by_model.length,
      providers: providers ? new Set(t.by_model.map((m) => m.name.split("/")[0])).size : null,
    },
  };
}

export function liveDashboard(d: LiveData, provider: Provider): DashboardVM {
  const series = denseSeries(d.activity.days, ACTIVITY_DAYS, d.summary.day);
  const hasActivity = d.summary.total.events > 0;
  const sessions = d.sessions.sessions.map(toSession);
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
    opencode: activityTool(d.opencode, true),
    antigravity: toolQuotas(d.quotas, "antigravity"),
    sessions,
    sessionsTotal: d.sessions.total,
  };
}
