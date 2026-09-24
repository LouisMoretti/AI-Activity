import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type {
  ActivityResponse, ProfilesResponse, QuotasResponse, SessionsResponse, StatsResponse, SummaryResponse,
} from "../../shared/types.ts";
import {
  breakdown, countSessions, dailyBuckets, findUserByUsername, latestQuotas, listProfiles, recentSessions,
  usageTotals,
} from "../db/queries.ts";
import { nowSec, type DB } from "../db/schema.ts";
import { intParam } from "../lib/http.ts";
import type { ViewerEnv } from "../lib/viewer-auth.ts";

/**
 * Whose usage to show: `?user=<username>` opens another profile (read-only,
 * any signed-in viewer), otherwise the viewer's own. Devices, billing and
 * account settings never take this parameter.
 */
function profileUserId(db: DB, c: Context<ViewerEnv>): number {
  const username = c.req.query("user");
  if (!username) return c.get("userId");
  const user = findUserByUsername(db, username);
  if (!user || user.disabled || !user.password_hash) throw new HTTPException(404, { message: "profile not found" });
  return user.id;
}

/** Read-only measured usage: stats, heatmap buckets, quotas, sessions. */
export function usageRoutes(db: DB) {
  return new Hono<ViewerEnv>()
    .get("/profiles", (c) => c.json<ProfilesResponse>({ profiles: listProfiles(db) }))
    .get("/stats", (c) => {
      const days = intParam(c, "days", 30, 1, 730);
      const tool = c.req.query("tool") || null;
      const totals = usageTotals(db, profileUserId(db, c), nowSec() - days * 86400, tool);
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
        days: dailyBuckets(db, profileUserId(db, c), nowSec() - days * 86400, tool),
        provenance: "measured device events",
      });
    })
    .get("/quotas", (c) =>
      c.json<QuotasResponse>({
        quotas: latestQuotas(db, profileUserId(db, c)),
        provenance: "latest snapshot provided by the account (never summed across devices)",
      }))
    .get("/summary", (c) => {
      const uid = profileUserId(db, c);
      const tool = c.req.query("tool") || null;
      const now = new Date();
      // "Today" is the current UTC day, matching the activity buckets.
      const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
      return c.json<SummaryResponse>({
        tool,
        day: new Date(dayStart * 1000).toISOString().slice(0, 10),
        total: breakdown(db, uid, 0, tool),
        today: breakdown(db, uid, dayStart, tool),
        provenance: "measured device events (incremental token counts only)",
      });
    })
    .get("/sessions", (c) => {
      const uid = profileUserId(db, c);
      const tool = c.req.query("tool") || null;
      return c.json<SessionsResponse>({
        sessions: recentSessions(
          db, uid, intParam(c, "limit", 10, 1, 200), tool, intParam(c, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
        ),
        total: countSessions(db, uid, tool),
        provenance: "grouped by unique session id from device events",
      });
    });
}
