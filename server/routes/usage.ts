import { Hono } from "hono";
import type {
  ActivityResponse, QuotasResponse, SessionsResponse, StatsResponse, SummaryResponse,
} from "../../shared/types.ts";
import {
  breakdown, countSessions, dailyBuckets, latestQuotas, recentSessions, usageTotals,
} from "../db/queries.ts";
import { nowSec, type DB } from "../db/schema.ts";
import { intParam } from "../lib/http.ts";

/** Read-only measured usage: stats, heatmap buckets, quotas, sessions. */
export function usageRoutes(db: DB, userId: () => number) {
  return new Hono()
    .get("/stats", (c) => {
      const days = intParam(c, "days", 30, 1, 730);
      const tool = c.req.query("tool") || null;
      const totals = usageTotals(db, userId(), nowSec() - days * 86400, tool);
      return c.json<StatsResponse>({
        range_days: days,
        tool,
        ...totals,
        total_tokens: Number(totals.total_tokens),
        has_data: Number(totals.events) > 0,
        provenance: "measured device events (incremental token counts only)",
      });
    })
    .get("/activity", (c) => {
      const days = intParam(c, "days", 364, 1, 730);
      const tool = c.req.query("tool") || null;
      return c.json<ActivityResponse>({
        days: dailyBuckets(db, userId(), nowSec() - days * 86400, tool),
        provenance: "measured device events",
      });
    })
    .get("/quotas", (c) =>
      c.json<QuotasResponse>({
        quotas: latestQuotas(db, userId()),
        provenance: "latest snapshot provided by the account (never summed across devices)",
      }))
    .get("/summary", (c) => {
      const tool = c.req.query("tool") || null;
      const now = new Date();
      // "Today" is the current UTC day, matching the activity buckets.
      const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
      return c.json<SummaryResponse>({
        tool,
        day: new Date(dayStart * 1000).toISOString().slice(0, 10),
        total: breakdown(db, userId(), 0, tool),
        today: breakdown(db, userId(), dayStart, tool),
        provenance: "measured device events (incremental token counts only)",
      });
    })
    .get("/sessions", (c) => {
      const tool = c.req.query("tool") || null;
      return c.json<SessionsResponse>({
        sessions: recentSessions(db, userId(), intParam(c, "limit", 10, 1, 200), tool),
        total: countSessions(db, userId(), tool),
        provenance: "grouped by unique session id from device events",
      });
    });
}
