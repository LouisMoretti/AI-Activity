import { Hono, type Context } from "hono";
import type { AuthStatus } from "../../shared/types.ts";
import {
  accountsExist, createFirstAccount, findUsableInvite, findUserByUsername, hashKey, redeemInvite,
} from "../db/queries.ts";
import type { DB } from "../db/schema.ts";
import { readJson } from "../lib/http.ts";
import {
  hashPassword, PASSWORD_MAX, passwordProblem, usernameProblem, verifyPassword,
} from "../lib/passwords.ts";
import { setupCodeMatches } from "../lib/setup.ts";
import type { ViewerAuth } from "../lib/viewer-auth.ts";

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const displayName = (v: unknown) => text(v).slice(0, 60) || null;
const isTaken = (err: unknown) => (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE";

/** The new account's fields, or an error message. */
function newAccountFields(body: Record<string, unknown>) {
  const username = text(body.username);
  const problem = usernameProblem(username) ?? passwordProblem(body.password);
  return problem ?? { username, password: body.password as string, display_name: displayName(body.display_name) };
}

/**
 * setupCode: printed in the server log while no account exists; it lets the
 * first account be created from the browser without handing the public
 * tunnel to whoever gets there first.
 */
export function authRoutes(db: DB, auth: ViewerAuth, setupCode: string | null) {
  /** 429 with Retry-After when this client (or everyone) failed too often. */
  const throttle = (c: Context) => {
    const wait = auth.throttled(c);
    if (!wait) return null;
    c.header("retry-after", String(wait));
    return c.json({ error: "too many failed attempts, try again later" }, 429);
  };

  return new Hono()
    .get("/status", (c) => {
      const who = auth.resolve(c);
      return c.json<AuthStatus>({
        authenticated: Boolean(who),
        user: who?.account ?? null,
        setup_required: !accountsExist(db),
      });
    })
    .post("/login", async (c) => {
      const body = await readJson(c);
      const username = typeof body.username === "string" ? body.username.trim() : "";
      const password = typeof body.password === "string" ? body.password.slice(0, PASSWORD_MAX + 1) : "";
      const limited = throttle(c);
      if (limited) return limited;
      if (!accountsExist(db)) return c.json({ error: "no account yet: create the first one" }, 400);
      const user = username ? findUserByUsername(db, username) : null;
      const usable = user && !user.disabled ? user.password_hash : null;
      // Always hash, even for unknown users, so timing does not reveal them.
      const ok = await verifyPassword(password, usable);
      auth.record(c, ok);
      if (!ok || !user) return c.json({ error: "invalid username or password" }, 401);
      auth.login(c, user.id);
      return c.json({ ok: true });
    })
    // First account, from the browser: needs the setup code from the server log.
    .post("/setup", async (c) => {
      const body = await readJson(c);
      const limited = throttle(c);
      if (limited) return limited;
      if (accountsExist(db) || !setupCode) return c.json({ error: "an account already exists: sign in" }, 409);
      const ok = setupCodeMatches(setupCode, body.setup_code);
      auth.record(c, ok);
      if (!ok) return c.json({ error: "wrong setup code: copy it from the server log" }, 401);
      const fields = newAccountFields(body);
      if (typeof fields === "string") return c.json({ error: fields }, 400);
      const id = createFirstAccount(db, {
        username: fields.username, display_name: fields.display_name,
        password_hash: await hashPassword(fields.password), is_admin: true,
      });
      if (id === null) return c.json({ error: "an account already exists: sign in" }, 409);
      auth.login(c, id);
      return c.json({ ok: true });
    })
    .get("/invite/:token", (c) => {
      const invite = findUsableInvite(db, hashKey(c.req.param("token")));
      return c.json({ valid: Boolean(invite), expires_at: invite?.expires_at ?? null });
    })
    // Account from an admin's invite link (single use, expires).
    .post("/signup", async (c) => {
      const body = await readJson(c);
      const limited = throttle(c);
      if (limited) return limited;
      const tokenHash = hashKey(text(body.invite));
      if (!findUsableInvite(db, tokenHash)) {
        auth.record(c, false);
        return c.json({ error: "this invite link is invalid, used or expired" }, 404);
      }
      const fields = newAccountFields(body);
      if (typeof fields === "string") return c.json({ error: fields }, 400);
      const password_hash = await hashPassword(fields.password);
      let id: number | null;
      try {
        id = redeemInvite(db, tokenHash, { username: fields.username, display_name: fields.display_name, password_hash });
      } catch (err) {
        if (isTaken(err)) return c.json({ error: "that username is taken" }, 409);
        throw err;
      }
      if (id === null) return c.json({ error: "this invite link is invalid, used or expired" }, 404);
      auth.login(c, id);
      return c.json({ ok: true });
    })
    .post("/logout", (c) => {
      auth.logout(c);
      return c.json({ ok: true });
    });
}
