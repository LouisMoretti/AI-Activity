// Pure helpers over a daily token series (UTC days, oldest first).
import type { ActivityDay } from "../../../shared/types.ts";

export type DayPoint = Pick<ActivityDay, "day" | "tokens">;

/**
 * The last n UTC days ending today, as "YYYY-MM-DD". UTC matches the server
 * buckets (date(occurred_at, 'unixepoch')); local-midnight math would shift
 * the range a day back in UTC+ timezones.
 */
export function lastUtcDays(n: number, now = new Date()): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: n }, (_, i) =>
    new Date(today - (n - 1 - i) * 86400000).toISOString().slice(0, 10));
}

/** Fill a sparse server series into a dense one; missing days are 0 tokens (no events). */
export function denseSeries(days: ActivityDay[], n: number): DayPoint[] {
  const byDay = new Map(days.map((d) => [d.day, Number(d.tokens) || 0]));
  return lastUtcDays(n).map((day) => ({ day, tokens: byDay.get(day) ?? 0 }));
}

export function streaks(series: DayPoint[]) {
  let longest = 0;
  let run = 0;
  for (const d of series) {
    run = d.tokens > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let current = 0;
  for (let i = series.length - 1; i >= 0 && series[i].tokens > 0; i--) current++;
  return { current, longest };
}

export const peak = (series: DayPoint[]) => Math.max(0, ...series.map((d) => d.tokens));

export function weeklyTotals(series: DayPoint[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < series.length; i += 7) {
    out.push(series.slice(i, i + 7).reduce((a, d) => a + d.tokens, 0));
  }
  return out;
}

export function cumulative(values: number[]): number[] {
  let acc = 0;
  return values.map((v) => (acc += v));
}

/**
 * Calendar grid: one column per week, rows Sunday..Saturday. The first
 * column is padded with nulls so every cell sits on its real weekday.
 */
export function calendarWeeks(series: DayPoint[]): (DayPoint | null)[][] {
  if (!series.length) return [];
  const pad = new Date(series[0].day + "T00:00:00Z").getUTCDay();
  const cells: (DayPoint | null)[] = [...Array(pad).fill(null), ...series];
  const weeks: (DayPoint | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/**
 * Month labels per calendar column: a label on the first week of each month.
 * A label is dropped when the next one starts fewer than minGap columns
 * later (e.g. a partial first month), so text never overlaps.
 */
export function monthLabels(
  weeks: (DayPoint | null)[][],
  name: (iso: string) => string,
  minGap = 3,
): string[] {
  const firstDays = weeks.map((w) => w.find((d) => d !== null)?.day ?? null);
  const labels = firstDays.map((day, i) => {
    if (!day) return "";
    const prev = i > 0 ? firstDays[i - 1] : null;
    return prev && name(prev) === name(day) ? "" : name(day);
  });
  for (let i = 0; i < labels.length; i++) {
    if (!labels[i]) continue;
    const next = labels.findIndex((l, j) => j > i && l !== "");
    if (next !== -1 && next - i < minGap) labels[i] = "";
  }
  return labels;
}

/** Heat level 0..4 relative to the series max (0 only for no activity). */
export const level = (tokens: number, max: number) =>
  tokens <= 0 ? 0 : Math.max(1, Math.ceil((tokens / Math.max(1, max)) * 4));
