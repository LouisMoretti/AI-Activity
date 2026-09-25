import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type {
  ActivityResponse, LeaderboardResponse, Profile, ProfilesResponse, QuotasResponse, SessionsResponse, StatsResponse,
  SummaryResponse,
} from "../../shared/types.ts";
import {
  breakdown, countSessions, dailyBuckets, findUserByUsername, latestQuotas, leaderboard, listProfiles, recentSessions,
  toAccount, usageTotals,
} from "../db/queries.ts";
import { nowSec, type DB } from "../db/schema.ts";
import { intParam } from "../lib/http.ts";
import type { ViewerEnv } from "../lib/viewer-auth.ts";

/** Days of the leaderboard's global heatmap (one year, like a profile's). */
const LEADERBOARD_ACTIVITY_DAYS = 364;

/** Whose usage a request reads. */
type Owner = (c: Context) => number;

/** Read-only measured usage: stats, heatmap buckets, quotas, sessions. */
function usage(db: DB, owner: Owner) {
  return new Hono()
    .get("/stats", (c) => {
      const days = intParam(c, "days", 30, 1, 730);
      const tool = c.req.query("tool") || null;
      const totals = usageTotals(db, owner(c), nowSec() - days * 86400, tool);
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
        days: dailyBuckets(db, owner(c), nowSec() - days * 86400, tool),
        provenance: "measured device events",
      });
    })
    .get("/quotas", (c) =>
      c.json<QuotasResponse>({
        quotas: latestQuotas(db, owner(c)),
        provenance: "latest snapshot provided by the account (never summed across devices)",
      }))
    .get("/summary", (c) => {
      const uid = owner(c);
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
      const uid = owner(c);
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

/** Everyone's usage, ranked (/api/leaderboard). Public, like profile pages. */
export function leaderboardRoutes(db: DB) {
  return new Hono()
    .get("/", (c) => {
      const all = c.req.query("days") === "all";
      const days = intParam(c, "days", 30, 1, 730);
      const now = new Date();
      const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
      return c.json<LeaderboardResponse>({
        range_days: all ? null : days,
        ...leaderboard(
          db, all ? 0 : nowSec() - days * 86400, dayStart - (LEADERBOARD_ACTIVITY_DAYS - 1) * 86400,
          new Date(dayStart * 1000).toISOString().slice(0, 10),
        ),
        provenance: "measured device events of every enabled account (incremental token counts only)",
      });
    });
}

/** Every enabled account (/api/profiles). Public: the leaderboard lists them too. */
export function profileListRoutes(db: DB) {
  return new Hono().get("/", (c) => c.json<ProfilesResponse>({ profiles: listProfiles(db) }));
}

/** The signed-in viewer's own usage (/api/stats, /api/summary, …). */
export function usageRoutes(db: DB) {
  return new Hono<ViewerEnv>()
    .route("/", usage(db, (c) => (c as Context<ViewerEnv>).get("userId")));
}

/**
 * Public profile pages (/api/u/<username>/…): anyone, signed in or not, can
 * read an enabled account's usage. Only usage: cost, devices and account
 * settings have no public route.
 */
export function publicProfileRoutes(db: DB) {
  const owner = (c: Context) => {
    const user = findUserByUsername(db, c.req.param("username") ?? "");
    if (!user || user.disabled || !user.password_hash) throw new HTTPException(404, { message: "profile not found" });
    return user;
  };
  return new Hono()
    .get("/", (c) => {
      const { username, display_name } = toAccount(owner(c));
      return c.json<Profile>({ username, display_name });
    })
    .route("/", usage(db, (c) => owner(c).id));
}
