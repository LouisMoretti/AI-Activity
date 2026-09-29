import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AuthStatus } from "../../shared/types.ts";
import { accountsExist, createAccount, createFirstAccount, findUserByGithubId, signupOpen } from "../db/queries.ts";
import type { DB } from "../db/schema.ts";
import { applyGithubProfile, claimLogin } from "../lib/accounts.ts";
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
  | "denied" | "expired" | "github" | "disabled" | "setup" | "exists" | "closed" | "too_many" | "other_account"
  | "not_allowed";

/**
 * What a sign-in started with POST /api/auth/github does once GitHub sends
 * the browser back: sign in (or sign up), create the first account (the
 * setup code was checked), or sign the signed-in account in again (a
 * destructive action wants a recent sign-in: it must be the same account).
 */
type Pending = { next: string; redirectUri: string; expires: number } & (
  | { mode: "login" }
  | { mode: "setup" }
  | { mode: "reauth"; userId: number }
);

/** A path of this site (one leading "/"): "//host" or "/\\host" would leave it. */
const onSite = (path: string) => /^\/(?![/\\])/.test(path);

/**
 * A same-site path to come back to, normalized; anything else goes home.
 * No backslash, whitespace or control character anywhere (browsers drop
 * tabs and newlines from a Location: "/\t/evil.example" is "//evil..."),
 * and checked again once resolved: "/a/..//evil.example" is "//evil...".
 * The result is what every redirect uses, so it never changes on the way.
 */
export function safeNext(v: unknown): string {
  if (typeof v !== "string" || v.length > 512 || !onSite(v) || /[\s\\\x00-\x1f\x7f]/.test(v)) return "/";
  const url = new URL(v, "http://x");
  const path = url.pathname + url.search;
  return url.origin === "http://x" && onSite(path) ? path : "/";
}

/** `next` (a safeNext path) with ?auth_error=<error> added to its query. */
function withError(next: string, error: AuthError): string {
  const url = new URL(next, "http://x");
  url.searchParams.set("auth_error", error);
  const path = url.pathname + url.search;
  return onSite(path) ? path : `/?auth_error=${error}`;
}

/** The sign-in page with the error, still going to `next` once signed in. */
function signInWithError(next: string, error: AuthError): string {
  const q = new URLSearchParams(next === "/" ? {} : { next });
  q.set("auth_error", error);
  return `/?${q}`;
}

/**
 * setupCode: printed in the server log while no account exists; the first
 * GitHub sign-in must give it, so whoever reaches the public address first
 * cannot take the server.
 */
export function authRoutes(
  db: DB, auth: ViewerAuth, client: ClientInfo, github: GithubConfig | null, publicUrl: string | null,
  setupCode: string | null,
  preview = false,
) {
  let signups = new Map<string, number>(); // client → accounts created in window
  let signupWindow = Date.now();
  const pending = new Map<string, Pending>(); // state → sign-in in progress

  const callbackUrl = (c: Context) => {
    const origin = publicUrl ?? `${client.isHttps(c) ? "https" : "http"}://${c.req.header("host") ?? "localhost"}`;
    return `${origin}/api/auth/github/callback`;
  };

  /** Accounts this client made in the current window (a new window starts from zero). */
  const signupsBy = (c: Context) => {
    if (Date.now() - signupWindow > SIGNUP_WINDOW_MS) {
      signups = new Map();
      signupWindow = Date.now();
    }
    return signups.get(auth.clientId(c)) ?? 0;
  };

  /** A new account for this GitHub user, or why not. Counted against the client only once made. */
  const signUp = (c: Context, gh: GithubUser, admin: boolean): number | AuthError => {
    if (!admin && signupsBy(c) >= SIGNUPS_PER_CLIENT) return "too_many";
    const id = db.transaction(() => {
      claimLogin(db, gh.login, null);
      const a = { username: gh.login, display_name: gh.name, avatar_url: gh.avatar_url, github_id: gh.id, is_admin: admin };
      return admin ? createFirstAccount(db, a) ?? ("exists" as const) : createAccount(db, a);
    })();
    if (typeof id === "number" && !admin) signups.set(auth.clientId(c), signupsBy(c) + 1);
    return id;
  };

  /** What the callback does for each kind of sign-in: the account to sign in, or why not. */
  const complete = (c: Context, p: Pending, gh: GithubUser): number | AuthError => {
    if (!auth.allows(gh.login)) return "not_allowed";
    if (p.mode === "setup") return accountsExist(db) ? "exists" : signUp(c, gh, true);
    const known = findUserByGithubId(db, gh.id);
    if (p.mode === "reauth" && known?.id !== p.userId) return "other_account";
    if (known) {
      if (known.disabled) return "disabled";
      applyGithubProfile(db, known.id, gh);
      return known.id;
    }
    if (!accountsExist(db)) return auth.limited ? signUp(c, gh, true) : "setup";
    if (!signupOpen(db)) return "closed";
    return signUp(c, gh, false);
  };

  return new Hono()
    .get("/status", (c) => {
      const who = auth.resolve(c);
      return c.json<AuthStatus>({
        ...(preview ? { preview: true } : {}),
        authenticated: Boolean(who),
        user: who?.account ?? null,
        setup_required: !accountsExist(db) && !auth.limited,
        signup_open: signupOpen(db),
        github_sign_in: github !== null,
      });
    })
    // Starts a GitHub sign-in: {next?, setup_code?, reauth?} → {url} to send
    // the browser to. The state ties the callback to this browser (cookie).
    .post("/github", async (c) => {
      if (!github) return c.json({ error: "Sign in with GitHub is not set up on this server" }, 503);
      const body = await readJson(c);
      const base = { next: safeNext(body.next), redirectUri: callbackUrl(c), expires: Date.now() + PENDING_MS };
      let p: Pending;
      if (body.reauth === true) {
        const who = auth.resolve(c);
        if (!who) return c.json({ error: "sign in first" }, 401);
        p = { ...base, mode: "reauth", userId: who.userId };
      } else if (!accountsExist(db) && !auth.limited) {
        if (!setupCode) return c.json({ error: "no setup code: restart the server for a new one" }, 409);
        const wait = auth.attempt(c);
        if (wait) {
          c.header("retry-after", String(wait));
          return c.json({ error: "too many failed attempts, try again later" }, 429);
        }
        if (!setupCodeMatches(setupCode, body.setup_code)) {
          return c.json({ error: "wrong setup code: copy it from the server log" }, 401);
        }
        auth.succeeded(c);
        p = { ...base, mode: "setup" };
      } else {
        p = { ...base, mode: "login" };
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
      return c.json({ url: authorizeUrl(github, p.redirectUri, state) });
    })
    // GitHub sends the browser back here, with a code to exchange.
    .get("/github/callback", async (c) => {
      const state = c.req.query("state") ?? "";
      const p = state && getCookie(c, STATE_COOKIE) === state ? pending.get(state) : undefined;
      if (p) {
        // Once only. A forged or foreign state leaves the cookie alone: a
        // cross-site link must not cancel a sign-in in progress.
        pending.delete(state);
        deleteCookie(c, STATE_COOKIE, { httpOnly: true, path: STATE_PATH, sameSite: "Lax", secure: client.isHttps(c) });
      }
      // Where a failure is told: signing in again comes back to where it
      // started (Settings); a sign-in goes back to the sign-in page, still
      // headed for `next`. Without its state (a restart, another tab's
      // sign-in, too many pending), a signed-in viewer was signing in again.
      const fail = (error: AuthError) => c.redirect(
        p?.mode === "reauth" ? withError(p.next, error)
        : p ? signInWithError(p.next, error)
        : auth.resolve(c) ? withError("/settings", error)
        : signInWithError("/", error), 302);
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
        // Two sign-ins of the same new GitHub user racing: the unique
        // indexes let one through; the other tries again (then signs in).
        if ((err as { code?: string }).code !== "SQLITE_CONSTRAINT_UNIQUE") throw err;
        result = "expired";
      }
      if (typeof result !== "number") return fail(result);
      auth.login(c, result);
      return c.redirect(p.next, 302);
    })
    .post("/logout", (c) => {
      auth.logout(c);
      return c.json({ ok: true });
    });
}
