// What the components render. Live data and the demo dataset are both
// mapped into these shapes, so components never branch on the data source.
// Time-relative text (countdowns, "x ago") is derived in components from
// timestamps here plus the shared clock.
import type { QUOTA_POOLS, QuotaWindowType } from "../../../shared/quota-pools.ts";
import { TOOLS, type ApiValue, type Session, type Tool } from "../../../shared/types.ts";
import type { DayPoint } from "./series.ts";

export type ToolKey = Tool;
export type Provider = "all" | ToolKey;

export interface ShareRow { name: string; value: number }

/** A headline figure with where it comes from (shown on hover). */
export interface FigureVM {
  value: number | null; // null → "—" (no data), never guessed
  byTool: ShareRow[];
  byModel: ShareRow[];
  /** Exact union for model rows folded into "others"; sessions only. */
  byModelOthers: number | null;
}

/**
 * Estimated API-equivalent value (shared/pricing.ts): measured tokens at
 * published retail API rates. Not actual spend.
 */
export interface ValueVM {
  usd: number | null; // null → nothing priced ("—"), never $0
  pricedTokens: number;
  unpricedTokens: number; // left out: tools or models without a published rate
  lowerBound: boolean; // some cache writes priced at the cheaper rate (duration unknown)
  fallback: boolean; // some usage priced at a rate published after it
  unverified: boolean; // some usage priced from community rates (LiteLLM), not verified ones
  byTool: ShareRow[]; // USD, priced rows only
  byModel: ShareRow[];
}

export interface StatsVM {
  total: FigureVM; // all-time tokens
  today: FigureVM; // tokens today (the owner's local day)
  sessions: FigureVM; // all-time conversations
  streak: { current: number; longest: number } | null;
  value: {
    total: ValueVM; // all time
    today: ValueVM;
    /** Latest measured event, null without usage: how fresh the figures are. */
    lastEventAt: number | null;
    pricingVersion: string;
  };
}

export interface QuotaWindowVM {
  label: string;
  pct: number | null; // null → "Unavailable"
  resetsAt: number | null; // epoch seconds
  spanSec: number; // window length, for the "where are we in the window" mark
}

/** One quota pool: its windows are shown together, never summed with another's. */
export interface QuotaPoolVM {
  label: string | null; // null → the tool's only pool, no heading
  windows: QuotaWindowVM[];
}

export interface QuotaToolVM {
  tool: "claude-code" | "codex" | "antigravity";
  updatedAt: number | null; // latest snapshot time
  pools: QuotaPoolVM[];
}

/** A tool without quota windows: its card shows what is going on now. */
export interface ActivityToolVM {
  /** False after a failed read: the card says Unavailable, never guessed zeros. */
  available?: boolean;
  recent: SessionVM[]; // the tool's latest conversations, newest first; empty → no usage yet
  // providers: null for tools whose models are not stored as provider/model.
  today: { tokens: number; sessions: number; calls: number; models: number; providers: number | null };
}

export interface SessionVM {
  tool: ToolKey;
  id: string;
  model: string | null;
  calls: number;
  tokens: number;
  lastActive: number;
  context: { pct: number; size: number | null } | null; // only when reported
  value: ApiValue;
  unpriced: Session["unpriced"];
}


export interface DashboardVM {
  demo: boolean;
  today: string; // YYYY-MM-DD, the highlighted calendar day
  series: DayPoint[];
  hasActivity: boolean;
  stats: StatsVM;
  tools: ToolKey[]; // cards to show for the current filter
  claude: QuotaToolVM;
  codex: QuotaToolVM;
  cursor: ActivityToolVM;
  opencode: ActivityToolVM;
  antigravity: QuotaToolVM;
  // Shown instead of the quota windows while none is running (quotas are
  // optional for Antigravity: they need the signed-in agy CLI).
  antigravityActivity: ActivityToolVM;
  sessions: SessionVM[];
  sessionsTotal: number;
}

// color: the tool's design token, set as `--tool` on its elements.
export const TOOL_META: Record<ToolKey, { name: string; color: string; logo: string; callNoun?: string }> = {
  "claude-code": { name: "Claude Code", color: "var(--claude)", logo: "/tool-logos/claude.svg" },
  codex: { name: "Codex", color: "var(--codex)", logo: "/tool-logos/codex.svg" },
  cursor: { name: "Cursor", color: "var(--cursor)", logo: "/tool-logos/cursor.svg", callNoun: "Agent turn" },
  opencode: { name: "OpenCode", color: "var(--opencode)", logo: "/tool-logos/opencode.svg" },
  antigravity: { name: "Antigravity", color: "var(--antigravity)", logo: "/tool-logos/antigravity.png" },
};

type PoolId = (typeof QUOTA_POOLS)[keyof typeof QUOTA_POOLS][number];
/** Headings of the quota pools in shared/quota-pools.ts. */
export const POOL_LABELS: Record<PoolId, string> = { gemini: "Gemini", "claude-gpt": "Claude/GPT" };

export const toolName = (key: string) =>
  key in TOOL_META ? TOOL_META[key as ToolKey].name : key;

export const toolsFor = (p: Provider): ToolKey[] =>
  p === "all" ? [...TOOLS] : [p];

/** Labels of the quota windows, in display order (spans: QUOTA_WINDOW_SEC). */
export const WINDOW_LABELS: Record<QuotaWindowType, string> = { five_hour: "5-hour window", seven_day: "This week" };

/** Whether a quota card has a measured window still running at `now`. */
export const hasLiveWindow = (q: QuotaToolVM, now: number): boolean =>
  q.pools.some((p) => p.windows.some((w) => w.pct !== null && (w.resetsAt === null || w.resetsAt > now)));
