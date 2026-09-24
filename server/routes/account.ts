import { Hono, type MiddlewareHandler } from "hono";
import type { Account, AdminUser } from "../../shared/types.ts";
import { randomBytes } from "node:crypto";
import type { AdminOverview, AdminSettings, Invite } from "../../shared/types.ts";
import {
  adminOverview, createAccount, createInvite, setSignupOpen, signupOpen, deleteUserSessions, findUserByUsername, getUser, hashKey, listAdminUsers,
  listPendingInvites, revokeInvite, setDisplayName, setPasswordHash, setUserDisabled, toAccount,
} from "../db/queries.ts";
import { nowSec } from "../db/schema.ts";
import type { DB } from "../db/schema.ts";
import { readJson } from "../lib/http.ts";
import { hashPassword, passwordProblem, usernameProblem, verifyPassword } from "../lib/passwords.ts";
import type { ViewerAuth, ViewerEnv } from "../lib/viewer-auth.ts";

const DISPLAY_NAME_MAX = 60;
const INVITE_SEC = 7 * 86400;

/** Trimmed display name, or null to fall back to the username. */
const displayName = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, DISPLAY_NAME_MAX) : null;

const requireAdmin: MiddlewareHandler<ViewerEnv> = async (c, next) => {
  if (!c.get("account").is_admin) return c.json({ error: "admin only" }, 403);
  await next();
};

/** The signed-in user's own profile. */
export function accountRoutes(db: DB, auth: ViewerAuth) {
  return new Hono<ViewerEnv>()
    .post("/", async (c) => {
      const body = await readJson(c);
      const id = c.get("userId");
      setDisplayName(db, id, displayName(body.display_name));
      return c.json<{ user: Account }>({ user: toAccount(getUser(db, id)!) });
    })
    .post("/password", async (c) => {
      const body = await readJson(c);
      const wait = auth.throttled(c);
      if (wait) {
        c.header("retry-after", String(wait));
        return c.json({ error: "too many failed attempts, try again later" }, 429);
      }
      const user = getUser(db, c.get("userId"))!;
      const current = typeof body.current_password === "string" ? body.current_password : "";
      // Guessing the current password from a stolen session is throttled like a login.
      const ok = await verifyPassword(current, user.password_hash);
      auth.record(c, ok);
      if (!ok) return c.json({ error: "current password is wrong" }, 400);
      const problem = passwordProblem(body.new_password);
      if (problem) return c.json({ error: problem }, 400);
      setPasswordHash(db, user.id, await hashPassword(body.new_password as string));
      // Other browsers are signed out; this one stays signed in.
      deleteUserSessions(db, user.id, auth.sessionHash(c));
      return c.json({ ok: true });
    });
}

/** Admin-only account management. */
export function userRoutes(db: DB) {
  const target = (id: string) => getUser(db, Number(id));
  return new Hono<ViewerEnv>()
    .use(requireAdmin)
    .get("/", (c) => c.json<{ users: AdminUser[] }>({ users: listAdminUsers(db) }))
    .get("/invites", (c) => c.json<{ invites: Invite[] }>({ invites: listPendingInvites(db) }))
    // The token is returned once; only its hash is stored.
    .post("/invites", (c) => {
      const token = randomBytes(24).toString("base64url");
      const expires_at = nowSec() + INVITE_SEC;
      const id = createInvite(db, hashKey(token), c.get("userId"), expires_at);
      return c.json({ ok: true, id, token, expires_at });
    })
    .post("/invites/:id{[0-9]+}/revoke", (c) =>
      revokeInvite(db, Number(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "invite not found" }, 404))
    .post("/", async (c) => {
      const body = await readJson(c);
      const username = typeof body.username === "string" ? body.username.trim() : "";
      const problem = usernameProblem(username) ?? passwordProblem(body.password);
      if (problem) return c.json({ error: problem }, 400);
      const taken = () => c.json({ error: "that username is taken" }, 409);
      if (findUserByUsername(db, username)) return taken();
      const password_hash = await hashPassword(body.password as string);
      try {
        const id = createAccount(db, {
          username, display_name: displayName(body.display_name), password_hash, is_admin: body.is_admin === true,
        });
        return c.json({ ok: true, id });
      } catch (err) {
        // Created meanwhile (double submit, CLI) while the password was hashing.
        if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") return taken();
        throw err;
      }
    })
    .post("/:id{[0-9]+}/password", async (c) => {
      const user = target(c.req.param("id"));
      if (!user) return c.json({ error: "user not found" }, 404);
      // Own password goes through /api/account/password, which needs the
      // current one: a stolen admin session must not be able to take over.
      if (user.id === c.get("userId")) return c.json({ error: "change your own password from your account" }, 400);
      const body = await readJson(c);
      const problem = passwordProblem(body.password);
      if (problem) return c.json({ error: problem }, 400);
      setPasswordHash(db, user.id, await hashPassword(body.password as string));
      deleteUserSessions(db, user.id);
      return c.json({ ok: true });
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
