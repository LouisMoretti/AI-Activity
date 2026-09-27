import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AuthStatus } from "../../shared/types.ts";
import {
  accountsExist, createAccount, createFirstAccount, findUserByGithubId, findUserByUsername, getUser, setGithubId,
  setGithubProfile, setUsername, signupOpen,
} from "../db/queries.ts";
import type { DB } from "../db/schema.ts";
import type { ClientInfo } from "../lib/client.ts";
import { authorizeUrl, signedInUser, type GithubConfig, type GithubUser } from "../lib/github.ts";
import { readJson } from "../lib/http.ts";
import { setupCodeMatches } from "../lib/setup.ts";
import type { ViewerAuth } from "../lib/viewer-auth.ts";

/** Open sign-up: accounts one client may create per window (spam guard). */
const SIGNUPS_PER_CLIENT = 5;
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;

/** A sign-in started here must come back from GitHub within this time. */
const PENDING_MS = 10 * 60 * 1000;
/** Sign-ins in progress kept at most (the oldest go first). */
const PENDING_MAX = 10_000;
const STATE_COOKIE = "gh_oauth";
const STATE_PATH = "/api/auth/github";

/**
 * Why a sign-in failed, as the `auth_error` of the page it lands on (the
 * web client says it in words: a link cannot put any text on the page).
 */
export type AuthError =
  | "denied" | "expired" | "github" | "disabled" | "setup" | "exists" | "closed" | "too_many" | "taken"
  | "linked_elsewhere" | "already_linked";

/**
 * What a sign-in started with POST /api/auth/github does once GitHub sends
 * the browser back: sign in (or sign up), create the first account (the
 * setup code was checked), or link the signed-in account.
 */
type Pending =
  | { mode: "login"; next: string; redirectUri: string; expires: number }
  | { mode: "setup"; next: string; redirectUri: string; expires: number }
  | { mode: "link"; next: string; redirectUri: string; expires: number; userId: number };

/** A same-site path to come back to; anything else goes home. */
export function safeNext(v: unknown): string {
  return typeof v === "string" && v.length <= 512 && /^\/(?![/\\])/.test(v) ? v : "/";
}

/**
 * setupCode: printed in the server log while no account exists; the first
 * GitHub sign-in must give it, so whoever reaches the public address first
 * cannot take the server.
 */
export function authRoutes(
  db: DB, auth: ViewerAuth, client: ClientInfo, github: GithubConfig | null, publicUrl: string | null,
  setupCode: string | null,
) {
  let signups = new Map<string, number>(); // client → accounts created in window
  let signupWindow = Date.now();
  const pending = new Map<string, Pending>(); // state → sign-in in progress

  const callbackUrl = (c: Context) => {
    const origin = publicUrl ?? `${client.isHttps(c) ? "https" : "http"}://${c.req.header("host") ?? "localhost"}`;
    return `${origin}/api/auth/github/callback`;
  };

  /** One more account from this client, or false over the cap. */
  const signupAllowed = (c: Context) => {
    if (Date.now() - signupWindow > SIGNUP_WINDOW_MS) {
      signups = new Map();
      signupWindow = Date.now();
    }
    const id = auth.clientId(c);
    if ((signups.get(id) ?? 0) >= SIGNUPS_PER_CLIENT) return false;
    signups.set(id, (signups.get(id) ?? 0) + 1);
    return true;
  };

  /**
   * Give the account its GitHub login as username, unless an account not
   * linked to GitHub holds that name (then it keeps the one it has; false).
   * A linked account holding it is stale (that GitHub user was renamed and
   * the login reused): it becomes "<name>-<id>" until it signs in again.
   */
  const claimLogin = (login: string, self: number | null): boolean => {
    const holder = findUserByUsername(db, login);
    if (!holder || holder.id === self) return true;
    if (holder.github_id === null) return false;
    setUsername(db, holder.id, `${holder.username}-${holder.id}`);
    return true;
  };

  /** The profile follows GitHub on every sign-in (and on linking). */
  const syncProfile = (userId: number, gh: GithubUser) => db.transaction(() => {
    const user = getUser(db, userId)!;
    const username = claimLogin(gh.login, userId) ? gh.login : user.username!;
    setGithubProfile(db, userId, { username, display_name: gh.name, avatar_url: gh.avatar_url });
  })();

  /** A new account for this GitHub user, or why not. */
  const signUp = (c: Context, gh: GithubUser, admin: boolean): number | AuthError => db.transaction(() => {
    if (!claimLogin(gh.login, null)) return "taken" as const;
    const a = { username: gh.login, display_name: gh.name, avatar_url: gh.avatar_url, github_id: gh.id, is_admin: admin };
    if (admin) return createFirstAccount(db, a) ?? ("exists" as const);
    if (!signupAllowed(c)) return "too_many" as const;
    return createAccount(db, a);
  })();

  /** What the callback does for each kind of sign-in: the account to sign in, or why not. */
  const complete = (c: Context, p: Pending, gh: GithubUser): number | AuthError => {
    const known = findUserByGithubId(db, gh.id);
    if (p.mode === "link") {
      if (auth.resolve(c)?.userId !== p.userId) return "expired";
      if (known && known.id !== p.userId) return "linked_elsewhere";
      const self = getUser(db, p.userId);
      if (!self) return "expired";
      if (self.github_id !== null && self.github_id !== gh.id) return "already_linked";
      setGithubId(db, p.userId, gh.id);
      syncProfile(p.userId, gh);
      return p.userId;
    }
    if (p.mode === "setup") return accountsExist(db) ? "exists" : signUp(c, gh, true);
    if (known) {
      if (known.disabled) return "disabled";
      syncProfile(known.id, gh);
      return known.id;
    }
    if (!accountsExist(db)) return "setup";
    if (!signupOpen(db)) return "closed";
    return signUp(c, gh, false);
  };

  return new Hono()
    .get("/status", (c) => {
      const who = auth.resolve(c);
      return c.json<AuthStatus>({
        authenticated: Boolean(who),
        user: who?.account ?? null,
        setup_required: !accountsExist(db),
        signup_open: signupOpen(db),
        github: github !== null,
      });
    })
    // Starts a GitHub sign-in: {next?, setup_code?, link?} → {url} to send
    // the browser to. The state ties the callback to this browser (cookie).
    .post("/github", async (c) => {
      if (!github) return c.json({ error: "Sign in with GitHub is not set up on this server" }, 503);
      const body = await readJson(c);
      const next = safeNext(body.next);
      const redirectUri = callbackUrl(c);
      const expires = Date.now() + PENDING_MS;
      let p: Pending;
      if (body.link === true) {
        const who = auth.resolve(c);
        if (!who) return c.json({ error: "sign in first" }, 401);
        p = { mode: "link", next, redirectUri, expires, userId: who.userId };
      } else if (!accountsExist(db)) {
        if (!setupCode) return c.json({ error: "no setup code: restart the server or use npm run user -- add" }, 409);
        const wait = auth.attempt(c);
        if (wait) {
          c.header("retry-after", String(wait));
          return c.json({ error: "too many failed attempts, try again later" }, 429);
        }
        if (!setupCodeMatches(setupCode, body.setup_code)) {
          return c.json({ error: "wrong setup code: copy it from the server log" }, 401);
        }
        auth.succeeded(c);
        p = { mode: "setup", next, redirectUri, expires };
      } else {
        p = { mode: "login", next, redirectUri, expires };
      }
      for (const [key, old] of pending) {
        if (old.expires < Date.now() || pending.size >= PENDING_MAX) pending.delete(key);
        else break; // in insertion order: the rest is newer
      }
      const state = randomBytes(32).toString("base64url");
      pending.set(state, p);
      setCookie(c, STATE_COOKIE, state, {
        httpOnly: true, path: STATE_PATH, sameSite: "Lax", maxAge: PENDING_MS / 1000, secure: client.isHttps(c),
      });
      return c.json({ url: authorizeUrl(github, redirectUri, state) });
    })
    // GitHub sends the browser back here, with a code to exchange.
    .get("/github/callback", async (c) => {
      const state = c.req.query("state") ?? "";
      const cookie = getCookie(c, STATE_COOKIE);
      deleteCookie(c, STATE_COOKIE, { httpOnly: true, path: STATE_PATH, sameSite: "Lax", secure: client.isHttps(c) });
      const p = state && cookie === state ? pending.get(state) : undefined;
      if (p) pending.delete(state); // once only
      const fail = (error: AuthError) =>
        c.redirect(p?.mode === "link" ? `/settings?auth_error=${error}` : `/?auth_error=${error}`, 302);
      if (!p || p.expires < Date.now() || !github) return fail("expired");
      const code = c.req.query("code");
      if (!code) return fail(c.req.query("error") === "access_denied" ? "denied" : "github");
      let gh: GithubUser;
      try {
        gh = await signedInUser(github, code, p.redirectUri);
      } catch (err) {
        console.error(`GitHub sign-in failed: ${(err as Error).message}`);
        return fail("github");
      }
      let result: number | AuthError;
      try {
        result = complete(c, p, gh);
      } catch (err) {
        // Two sign-ins racing for the same GitHub account or username: the
        // unique indexes let one through; the other tries again.
        if ((err as { code?: string }).code !== "SQLITE_CONSTRAINT_UNIQUE") throw err;
        result = "expired";
      }
      if (typeof result !== "number") return fail(result);
      if (p.mode !== "link") auth.login(c, result);
      return c.redirect(p.next, 302);
    })
    .post("/logout", (c) => {
      auth.logout(c);
      return c.json({ ok: true });
    });
}
