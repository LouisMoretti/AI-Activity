import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type {
  ActivityResponse, LeaderboardResponse, Profile, ProfilesResponse, QuotasResponse, SessionsResponse, StatsResponse,
  SummaryResponse,
} from "../../shared/types.ts";
import {
  breakdown, countSessions, dailyBuckets, findUserByUsername, latestQuotas, leaderboard, listProfiles, recentSessions,
  toProfile, usageTotals,
} from "../db/queries.ts";
import { nowSec, type DB } from "../db/schema.ts";
import { intParam } from "../lib/http.ts";

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
        provenance: "measured messages (one row per Anthropic message id)",
      });
    })
    .get("/activity", (c) => {
      const days = intParam(c, "days", 364, 1, 730);
      const tool = c.req.query("tool") || null;
      return c.json<ActivityResponse>({
        days: dailyBuckets(db, owner(c), nowSec() - days * 86400, tool),
        provenance: "measured messages",
      });
    })
    .get("/quotas", (c) =>
      c.json<QuotasResponse>({
        quotas: latestQuotas(db, owner(c)),
        provenance: "quota snapshots reported by the account's devices (never summed across devices)",
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
        provenance: "measured messages (one row per Anthropic message id)",
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
        provenance: "grouped by unique session id from measured messages",
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
        provenance: "measured messages of every enabled account (one row per Anthropic message id)",
      });
    });
}

/** Every enabled account (/api/profiles). Public: the leaderboard lists them too. */
export function profileListRoutes(db: DB) {
  return new Hono().get("/", (c) => c.json<ProfilesResponse>({ profiles: listProfiles(db) }));
}

/**
 * Public profile pages (/api/u/<username>/…): anyone, signed in or not, can
 * read an enabled account's usage, the owner included (there is no private
 * copy). Only usage: devices and account settings have no public route.
 */
export function publicProfileRoutes(db: DB) {
  const owner = (c: Context) => {
    const user = findUserByUsername(db, c.req.param("username") ?? "");
    if (!user || user.disabled || !user.password_hash) throw new HTTPException(404, { message: "profile not found" });
    return user;
  };
  return new Hono()
    .get("/", (c) => {
      return c.json<Profile>(toProfile(owner(c)));
    })
    .route("/", usage(db, (c) => owner(c).id));
}
