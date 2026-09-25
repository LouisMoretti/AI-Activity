import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calendarWeeks, cumulative, daysEndingOn, denseSeries, lastUtcDays, level, monthLabels, streaks, weeklyTotals,
} from "../web/src/lib/series.ts";

const pts = (...tokens) => tokens.map((t, i) => ({ day: `2026-01-${String(i + 1).padStart(2, "0")}`, tokens: t }));

test("lastUtcDays ends today (UTC) and is contiguous", () => {
  const days = lastUtcDays(3, new Date("2026-09-24T23:30:00-05:00")); // already 25th in UTC
  assert.deepEqual(days, ["2026-09-23", "2026-09-24", "2026-09-25"]);
});

test("daysEndingOn is contiguous across month and year ends", () => {
  assert.deepEqual(daysEndingOn("2027-01-01", 3), ["2026-12-30", "2026-12-31", "2027-01-01"]);
});

test("denseSeries fills missing days with zero, never interpolates", () => {
  const s = denseSeries([{ day: "2026-09-25", tokens: 5, sessions: 1 }], 4, "2026-09-25");
  assert.deepEqual(s.map((d) => d.tokens), [0, 0, 0, 5]);
});

test("denseSeries ends on the given day, not the viewer's clock", () => {
  // The owner is already on the 26th (UTC+14) while it is the 25th in UTC.
  const s = denseSeries([{ day: "2026-09-26", tokens: 7, sessions: 1 }], 2, "2026-09-26");
  assert.deepEqual(s, [{ day: "2026-09-25", tokens: 0 }, { day: "2026-09-26", tokens: 7 }]);
});

test("streaks: current counts back from today, longest over the range", () => {
  assert.deepEqual(streaks(pts(1, 1, 1, 0, 1, 1)), { current: 2, longest: 3 });
  assert.deepEqual(streaks(pts(1, 0)), { current: 0, longest: 1 });
});

test("calendarWeeks pads the first week so cells land on their weekday", () => {
  // 2026-01-01 is a Thursday → 4 leading blanks (Sun..Wed).
  const weeks = calendarWeeks(pts(1, 2, 3, 4));
  assert.equal(weeks[0].slice(0, 4).every((c) => c === null), true);
  assert.equal(weeks[0][4].day, "2026-01-01");
  assert.equal(weeks[1][0].day, "2026-01-04"); // Sunday starts the next column
});

test("weekly and cumulative totals", () => {
  const w = weeklyTotals(pts(1, 1, 1, 1, 1, 1, 1, 5));
  assert.deepEqual(w, [7, 5]);
  assert.deepEqual(cumulative(w), [7, 12]);
});

test("heat level is 0 only without activity", () => {
  assert.equal(level(0, 100), 0);
  assert.equal(level(1, 100), 1);
  assert.equal(level(100, 100), 4);
});

test("month labels never collide: a partial first month is dropped", () => {
  // Starts 2025-09-28 (Sunday): one September week, then October.
  const start = Date.UTC(2025, 8, 28);
  const series = Array.from({ length: 70 }, (_, i) => ({
    day: new Date(start + i * 86400000).toISOString().slice(0, 10), tokens: 0,
  }));
  const name = (iso) => iso.slice(0, 7);
  const labels = monthLabels(calendarWeeks(series), name);
  assert.equal(labels[0], ""); // "2025-09" would overlap "2025-10"
  assert.equal(labels[1], "2025-10");
  const shown = labels.map((l, i) => (l ? i : -1)).filter((i) => i >= 0);
  for (let k = 1; k < shown.length; k++) assert.ok(shown[k] - shown[k - 1] >= 3);
});
