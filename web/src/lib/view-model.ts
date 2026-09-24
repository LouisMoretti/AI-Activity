// What the components render. Live data and the demo dataset are both
// mapped into these shapes, so components never branch on the data source.
// Time-relative text (countdowns, "x ago") is derived in components from
// timestamps here plus the shared clock.
import type { DayPoint } from "./series.ts";

export type ToolKey = "claude-code" | "codex" | "opencode";
export type Provider = "all" | ToolKey;

export interface ShareRow { name: string; value: number }

/** A headline figure with where it comes from (shown on hover). */
export interface FigureVM {
  value: number | null; // null → "—" (no data), never guessed
  byTool: ShareRow[];
  byModel: ShareRow[];
}

export interface StatsVM {
  total: FigureVM; // all-time tokens
  today: FigureVM; // tokens today (UTC day)
  sessions: FigureVM; // all-time conversations
  streak: { current: number; longest: number } | null;
}

export interface QuotaWindowVM {
  label: string;
  pct: number | null; // null → "Unavailable"
  resetsAt: number | null; // epoch seconds
  spanSec: number; // window length, for the "where are we in the window" mark
}

export interface QuotaToolVM {
  tool: "claude-code" | "codex";
  connected: boolean;
  updatedAt: number | null; // latest snapshot time
  windows: QuotaWindowVM[];
}

export interface SessionVM {
  tool: ToolKey;
  id: string;
  model: string | null;
  calls: number;
  tokens: number;
  lastActive: number;
  context: { pct: number; size: number | null } | null; // only when reported
}

export interface CostCardVM { label: string; value: string | null; note: string }

export interface DashboardVM {
  demo: boolean;
  today: string; // YYYY-MM-DD, the highlighted calendar day
  series: DayPoint[];
  hasActivity: boolean;
  stats: StatsVM;
  tools: ToolKey[]; // cards to show for the current filter
  claude: QuotaToolVM;
  codex: QuotaToolVM;
  sessions: SessionVM[];
  sessionsTotal: number;
  /** Null on someone else's profile page: costs are private. */
  cost: CostCardVM[] | null;
}

export const TOOL_META: Record<ToolKey, { name: string; icon: string }> = {
  "claude-code": { name: "Claude Code", icon: "✳" },
  codex: { name: "Codex", icon: "⌘" },
  opencode: { name: "OpenCode", icon: "◇" },
};

export const toolName = (key: string) =>
  key in TOOL_META ? TOOL_META[key as ToolKey].name : key;

export const toolsFor = (p: Provider): ToolKey[] =>
  p === "all" ? ["claude-code", "codex", "opencode"] : [p];

export const WINDOW_SPANS = { five_hour: 5 * 3600, seven_day: 7 * 86400 } as const;
