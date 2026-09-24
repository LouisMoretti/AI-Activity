// What the components render. Live data and the demo dataset are both
// mapped into these shapes, so components never branch on the data source.
import type { DayPoint } from "./series.ts";

export type Provider = "all" | "claude-code" | "codex";
export type ToolKey = "claude-code" | "codex";

export interface StatVM { value: string; label: string }

export interface QuotaRowVM {
  label: string;
  pct: number | null; // null → "Unavailable", never guessed
  reset: string;
}

export interface QuotaCardVM {
  tool: ToolKey;
  name: string;
  badge: string;
  rows: QuotaRowVM[];
}

export interface SessionVM {
  tool: ToolKey;
  title: string;
  subtitle: string;
  tokensLabel: string;
  context: { used: number; max: number } | null; // only when the window size is known
}

export interface BillingCardVM { title: string; value: string; note: string }

export interface DashboardVM {
  demo: boolean;
  periodLabel: string;
  stats: StatVM[];
  series: DayPoint[];
  hasActivity: boolean;
  quotas: QuotaCardVM[];
  sessions: SessionVM[];
  sessionsSubtitle: string;
  billing: BillingCardVM[];
  footer: string;
}

export const TOOL_META: Record<ToolKey, { name: string; icon: string }> = {
  "claude-code": { name: "Claude Code", icon: "✳" },
  codex: { name: "Codex", icon: "⌘" },
};

export const toolsFor = (p: Provider): ToolKey[] =>
  p === "all" ? ["claude-code", "codex"] : [p];
