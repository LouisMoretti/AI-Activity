import { Hono } from "hono";
import type {
  ActivityResponse, QuotasResponse, SessionsResponse, StatsResponse,
} from "../../shared/types.ts";
import { dailyBuckets, latestQuotas, recentSessions, usageTotals } from "../db/queries.ts";
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
    .get("/sessions", (c) =>
      c.json<SessionsResponse>({
        sessions: recentSessions(db, userId(), intParam(c, "limit", 10, 1, 50)),
        provenance: "grouped by unique session id from device events",
      }));
}
