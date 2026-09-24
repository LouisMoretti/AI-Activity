import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calendarWeeks, cumulative, denseSeries, lastUtcDays, level, streaks, weeklyTotals,
} from "../web/src/lib/series.ts";

const pts = (...tokens) => tokens.map((t, i) => ({ day: `2026-01-${String(i + 1).padStart(2, "0")}`, tokens: t }));

test("lastUtcDays ends today (UTC) and is contiguous", () => {
  const days = lastUtcDays(3, new Date("2026-09-24T23:30:00-05:00")); // already 25th in UTC
  assert.deepEqual(days, ["2026-09-23", "2026-09-24", "2026-09-25"]);
});

test("denseSeries fills missing days with zero, never interpolates", () => {
  const s = denseSeries([{ day: lastUtcDays(1)[0], tokens: 5, sessions: 1 }], 4);
  assert.deepEqual(s.map((d) => d.tokens), [0, 0, 0, 5]);
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
