import { Hono, type Context } from "hono";
import type { AuthStatus } from "../../shared/types.ts";
import { accountsExist, createAccount, createFirstAccount, findUserByUsername, signupOpen } from "../db/queries.ts";
import type { DB } from "../db/schema.ts";
import { readJson } from "../lib/http.ts";
import {
  hashPassword, PASSWORD_MAX, passwordProblem, usernameProblem, verifyPassword,
} from "../lib/passwords.ts";
import { setupCodeMatches } from "../lib/setup.ts";
import type { ViewerAuth } from "../lib/viewer-auth.ts";

/** Open sign-up: accounts one client may create per window (spam guard). */
const SIGNUPS_PER_CLIENT = 5;
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;

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
  const tooMany = (c: Context, wait: number) => {
    if (!wait) return null;
    c.header("retry-after", String(wait));
    return c.json({ error: "too many failed attempts, try again later" }, 429);
  };

  let signups = new Map<string, number>(); // client → accounts created in window
  let signupWindow = Date.now();

  return new Hono()
    .get("/status", (c) => {
      const who = auth.resolve(c);
      return c.json<AuthStatus>({
        authenticated: Boolean(who),
        user: who?.account ?? null,
        setup_required: !accountsExist(db),
        signup_open: signupOpen(db),
      });
    })
    // Sign-up is open to anyone once the first (admin) account exists,
    // unless an admin closed it.
    .post("/register", async (c) => {
      const body = await readJson(c);
      // Only checks the login throttle: registering checks no password, so
      // there is no failure to count (sign-ups have their own cap below).
      const limited = tooMany(c, auth.throttled(c));
      if (limited) return limited;
      if (!accountsExist(db)) return c.json({ error: "create the first account with the setup code" }, 409);
      if (!signupOpen(db)) return c.json({ error: "sign-up is closed on this server" }, 403);
      if (Date.now() - signupWindow > SIGNUP_WINDOW_MS) {
        signups = new Map();
        signupWindow = Date.now();
      }
      const client = auth.clientId(c);
      if ((signups.get(client) ?? 0) >= SIGNUPS_PER_CLIENT) {
        c.header("retry-after", String(Math.ceil((signupWindow + SIGNUP_WINDOW_MS - Date.now()) / 1000)));
        return c.json({ error: "too many accounts created from here, try again later" }, 429);
      }
      const fields = newAccountFields(body);
      if (typeof fields === "string") return c.json({ error: fields }, 400);
      if (findUserByUsername(db, fields.username)) return c.json({ error: "that username is taken" }, 409);
      // Reserve the slot before hashing: concurrent requests must not all
      // pass the check while the password hashes.
      const window = signups;
      window.set(client, (window.get(client) ?? 0) + 1);
      const release = () => window.set(client, Math.max(0, (window.get(client) ?? 1) - 1));
      let id: number;
      try {
        const password_hash = await hashPassword(fields.password);
        id = createAccount(db, { username: fields.username, display_name: fields.display_name, password_hash, is_admin: false });
      } catch (err) {
        release();
        if (isTaken(err)) return c.json({ error: "that username is taken" }, 409);
        throw err;
      }
      auth.login(c, id);
      return c.json({ ok: true });
    })
    .post("/login", async (c) => {
      const body = await readJson(c);
      const username = typeof body.username === "string" ? body.username.trim() : "";
      const password = typeof body.password === "string" ? body.password.slice(0, PASSWORD_MAX + 1) : "";
      if (!accountsExist(db)) return c.json({ error: "no account yet: create the first one" }, 400);
      const limited = tooMany(c, auth.attempt(c));
      if (limited) return limited;
      const user = username ? findUserByUsername(db, username) : null;
      const usable = user && !user.disabled ? user.password_hash : null;
      // Always hash, even for unknown users, so timing does not reveal them.
      const ok = await verifyPassword(password, usable);
      if (!ok || !user) return c.json({ error: "invalid username or password" }, 401);
      auth.succeeded(c);
      auth.login(c, user.id);
      return c.json({ ok: true });
    })
    // First account, from the browser: needs the setup code from the server log.
    .post("/setup", async (c) => {
      const body = await readJson(c);
      if (accountsExist(db) || !setupCode) return c.json({ error: "an account already exists: sign in" }, 409);
      const limited = tooMany(c, auth.attempt(c));
      if (limited) return limited;
      if (!setupCodeMatches(setupCode, body.setup_code)) {
        return c.json({ error: "wrong setup code: copy it from the server log" }, 401);
      }
      auth.succeeded(c);
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
    .post("/logout", (c) => {
      auth.logout(c);
      return c.json({ ok: true });
    });
}
