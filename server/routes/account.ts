import { Hono, type MiddlewareHandler } from "hono";
import type { Account, AdminOverview, AdminSettings, AdminUser } from "../../shared/types.ts";
import {
  adminOverview, deleteUserSessions, getUser, listAdminUsers, setAvatarUrl, setDisplayName, setPasswordHash, setUserAdmin,
  setSignupOpen, setUserDisabled, signupOpen, toAccount,
} from "../db/queries.ts";
import type { DB } from "../db/schema.ts";
import { parseAvatarUrl } from "../lib/avatar.ts";
import { readJson } from "../lib/http.ts";
import { hashPassword, passwordProblem, verifyPassword } from "../lib/passwords.ts";
import type { ViewerAuth, ViewerEnv } from "../lib/viewer-auth.ts";

const DISPLAY_NAME_MAX = 60;

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
      // Each field is optional: only the ones sent are changed.
      if ("avatar_url" in body) {
        const avatar = parseAvatarUrl(body.avatar_url);
        if ("error" in avatar) return c.json({ error: avatar.error }, 400);
        setAvatarUrl(db, id, avatar.url);
      }
      if ("display_name" in body) setDisplayName(db, id, displayName(body.display_name));
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
