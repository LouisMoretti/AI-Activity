import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  DELETE_ACCOUNT_PHRASE, DELETE_ACTIVITY_PHRASE, type AdminOverview, type AdminSettings, type AdminUser, type DeletedAccount, type DeletedActivity,
} from "../../shared/types.ts";
import {
  adminOverview, deleteAccount, deleteUserActivity, deleteUserSessions, getUser, listAdminUsers, setUserAdmin,
  setSignupOpen, setUserDisabled, signupOpen, type UserRow,
} from "../db/queries.ts";
import { nowSec, type DB } from "../db/schema.ts";
import { readJson } from "../lib/http.ts";
import type { ViewerEnv } from "../lib/viewer-auth.ts";

/**
 * Destructive actions need a session opened this recently: a stolen
 * session cookie cannot sign in with GitHub again.
 */
export const RECENT_SIGN_IN_SEC = 10 * 60;

const requireAdmin: MiddlewareHandler<ViewerEnv> = async (c, next) => {
  if (!c.get("account").is_admin) return c.json({ error: "admin only" }, 403);
  await next();
};

/**
 * The signed-in user's own account. The profile (username, name, picture)
 * comes from GitHub at each sign-in: nothing to edit here.
 */
export function accountRoutes(db: DB) {
  /**
   * A destructive action on the signed-in user's own data: the typed phrase,
   * and a sign-in within RECENT_SIGN_IN_SEC (403 with `reauth: true`
   * otherwise: the client signs in with GitHub again, then retries). The
   * user, or the error answer.
   */
  async function confirmed(c: Context<ViewerEnv>, phrase: string): Promise<UserRow | Response> {
    const body = await readJson(c);
    if (body.confirm !== phrase) return c.json({ error: `type "${phrase}" to confirm` }, 400);
    if (nowSec() - c.get("signedInAt") > RECENT_SIGN_IN_SEC) {
      return c.json({ error: "sign in with GitHub again to confirm", reauth: true }, 403);
    }
    return getUser(db, c.get("userId"))!;
  }

  return new Hono<ViewerEnv>()
    // Deletes the signed-in user's own usage and quotas; the account,
    // profile, devices and sessions stay.
    .post("/delete-activity", async (c) => {
      const user = await confirmed(c, DELETE_ACTIVITY_PHRASE);
      if (user instanceof Response) return user;
      return c.json<{ ok: true; deleted: DeletedActivity }>({ ok: true, deleted: deleteUserActivity(db, user.id) });
    })
    // Deletes the signed-in user's account and everything tied to it. The
    // session goes with it: the client signs out.
    .post("/delete", async (c) => {
      const user = await confirmed(c, DELETE_ACCOUNT_PHRASE);
      if (user instanceof Response) return user;
      const result = deleteAccount(db, user.id);
      if (!result.ok) return c.json({ error: "you are the last admin: make another account admin first" }, 409);
      return c.json<{ ok: true; deleted: DeletedAccount }>({ ok: true, deleted: result.deleted });
    });
}

/** Admin-only account management. */
export function userRoutes(db: DB) {
  const target = (id: string) => getUser(db, Number(id));
  return new Hono<ViewerEnv>()
    .use(requireAdmin)
    .get("/", (c) => c.json<{ users: AdminUser[] }>({ users: listAdminUsers(db) }))
    // Grant or remove admin rights. Nobody changes their own role, so the
    // admin making the request always remains: there is never zero admins.
    .post("/:id{[0-9]+}/admin", async (c) => {
      const user = target(c.req.param("id"));
      if (!user) return c.json({ error: "user not found" }, 404);
      if (user.id === c.get("userId")) return c.json({ error: "you cannot change your own role" }, 400);
      const body = await readJson(c);
      if (typeof body.is_admin !== "boolean") return c.json({ error: "is_admin must be true or false" }, 400);
      setUserAdmin(db, user.id, body.is_admin);
      return c.json({ ok: true, is_admin: body.is_admin });
    })
    .post("/:id{[0-9]+}/:action{disable|enable}", (c) => {
      const user = target(c.req.param("id"));
      if (!user) return c.json({ error: "user not found" }, 404);
      const disable = c.req.param("action") === "disable";
      // Keeps at least one enabled admin: the one making the request.
      if (disable && user.id === c.get("userId")) return c.json({ error: "you cannot disable yourself" }, 400);
      setUserDisabled(db, user.id, disable);
      if (disable) deleteUserSessions(db, user.id);
      return c.json({ ok: true });
    });
}

/** Admin panel: server-wide overview and settings. */
export function adminRoutes(db: DB) {
  return new Hono<ViewerEnv>()
    .use(requireAdmin)
    .get("/overview", (c) => c.json<AdminOverview>(adminOverview(db)))
    .get("/settings", (c) => c.json<AdminSettings>({ signup_open: signupOpen(db) }))
    .post("/settings", async (c) => {
      const body = await readJson(c);
      if (typeof body.signup_open !== "boolean") return c.json({ error: "signup_open must be true or false" }, 400);
      setSignupOpen(db, body.signup_open);
      return c.json<AdminSettings>({ signup_open: signupOpen(db) });
    });
}
