// Maps measured API responses into the view model. Missing data stays
// null ("—" / "Unavailable"); nothing is interpolated.
import { QUOTA_POOLS, QUOTA_WINDOW_SEC, type QuotaWindowType } from "../../../shared/quota-pools.ts";
import {
  TOOLS, type ActivityResponse, type Breakdown, type QuotasResponse, type Session,
  type SessionsResponse, type SummaryResponse,
} from "../../../shared/types.ts";
import { denseSeries, streaks } from "./series.ts";
import {
  POOL_LABELS, toolsFor, WINDOW_LABELS, type DashboardVM, type FigureVM, type Provider,
  type ActivityToolVM, type QuotaToolVM, type SessionVM, type ToolKey,
} from "./view-model.ts";

export interface LiveData {
  summary: SummaryResponse;
  activity: ActivityResponse;
  quotas: QuotasResponse;
  sessions: SessionsResponse;
  /** OpenCode's card: its summary (today) and its latest sessions. */
  opencode: { summary: SummaryResponse; latest: SessionsResponse };
  /** Antigravity's card without quota windows: the same as OpenCode's. */
  antigravity: { summary: SummaryResponse; latest: SessionsResponse };
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

const WINDOW_TYPES = Object.keys(WINDOW_LABELS) as QuotaWindowType[];

// One pool per quota account_ref of the tool (shared/quota-pools.ts), or a
// single unlabeled pool matching any ref. Rows of other refs or limit types
// are not shown, so they never move the update time either.
function toolQuotas(q: QuotasResponse, tool: QuotaToolVM["tool"]): QuotaToolVM {
  const refs: readonly (keyof typeof POOL_LABELS | null)[] =
    tool in QUOTA_POOLS ? QUOTA_POOLS[tool as keyof typeof QUOTA_POOLS] : [null];
  const rows = q.quotas.filter((x) => x.tool === tool);
  const pools = refs.map((ref) => ({
    label: ref === null ? null : POOL_LABELS[ref],
    rows: WINDOW_TYPES.map((type) =>
      [type, rows.find((x) => x.limit_type === type && (ref === null || x.account_ref === ref))] as const),
  }));
  const shown = pools.flatMap((p) => p.rows.flatMap(([, row]) => (row ? [row.measured_at] : [])));
  return {
    tool,
    updatedAt: shown.length ? Math.max(...shown) : null,
    pools: pools.map((p) => ({
      label: p.label,
      windows: p.rows.map(([type, row]) => ({
        label: WINDOW_LABELS[type], pct: row?.used_pct ?? null,
        resetsAt: row?.resets_at ?? null, spanSec: QUOTA_WINDOW_SEC[type],
      })),
    })),
  };
}

const asTool = (t: string): ToolKey =>
  (TOOLS as readonly string[]).includes(t) ? (t as ToolKey) : "claude-code";

// Antigravity ids are stored "antigravity:<id>" (never colliding with other
// tools'); the list shows the id itself. The tool keeps rows apart.
const displayId = (id: string) => id.replace(/^antigravity:/, "");

const toSession = (s: Session): SessionVM => ({
  tool: asTool(s.tool),
  id: displayId(s.session_id),
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
    antigravityActivity: activityTool(d.antigravity, false),
    sessions,
    sessionsTotal: d.sessions.total,
  };
}
