import { createHash, randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Account } from "../../shared/types.ts";
import { deleteViewerSession, insertViewerSession, toAccount, viewerSessionUser } from "../db/queries.ts";
import { nowSec, type DB } from "../db/schema.ts";
import type { ClientInfo } from "./client.ts";

const COOKIE = "dash_session";
// Over HTTPS the cookie is `__Host-` prefixed: browsers refuse one set with a
// Domain, without Secure or off Path=/, so a host under the same parent
// domain cannot toss a session in (#188). Plain HTTP (local dev) cannot use
// the prefix, which requires Secure.
const HOST_COOKIE = `__Host-${COOKIE}`;
const SESSION_SEC = 30 * 86400;

/** Failed setup code attempts allowed per client, and in total, within one window. */
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAILS_PER_CLIENT = 10;
const FAILS_TOTAL = 50;

/** Hono env of every viewer route: who the request acts for. */
export type ViewerEnv = {
  Variables: {
    /** The signed-in viewer. */
    userId: number;
    account: Account;
    /** When this session was opened (unix seconds): destructive actions need a recent sign-in. */
    signedInAt: number;
  };
};

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Per-user viewer sessions, stored hashed in SQLite so they survive a
 * restart. Every viewer API needs one: with no account yet, nothing is
 * readable until the first account is created (with the setup code).
 * Accounts sign in with GitHub (routes/auth.ts). allowedLogins: the only
 * GitHub logins that may be signed in (config.ts), or null for anyone.
 */
export function createViewerAuth(db: DB, { clientId, isHttps }: ClientInfo, allowedLogins: ReadonlySet<string> | null = null) {
  let fails = new Map<string, number>(); // client → failures in window
  let failsTotal = 0;
  let windowStart = Date.now();

  const resetWindowIfDue = () => {
    if (Date.now() - windowStart < FAIL_WINDOW_MS) return;
    fails = new Map();
    failsTotal = 0;
    windowStart = Date.now();
  };

  const cookieName = (c: Context) => (isHttps(c) ? HOST_COOKIE : COOKIE);
  const cookieToken = (c: Context) => getCookie(c, cookieName(c)) || null;

  const allows = (login: string) => !allowedLogins || allowedLogins.has(login.toLowerCase());

  /** Who this request acts for, or null when it needs a login. */
  const resolve = (c: Context): { userId: number; account: Account; signedInAt: number } | null => {
    const token = cookieToken(c);
    const user = token ? viewerSessionUser(db, tokenHash(token)) : null;
    // A login taken off the list is signed out, not only kept from signing in.
    // Checked against the stored username: a GitHub rename lands in the
    // database at the next sign-in (the token is dropped, never polled), so
    // until then the session answers for the old login. Rows of rejected
    // sessions stay until their normal expiry; they authorize nothing.
    return user && allows(user.username)
      ? { userId: user.id, account: toAccount(user), signedInAt: user.session_created_at }
      : null;
  };

  return {
    resolve,
    /** Whether this GitHub login may sign in. */
    allows,
    /** Sign-in is limited to a list of logins: the first of them to sign in becomes the admin, no setup code. */
    limited: allowedLogins !== null,
    /** The client address the per-client limits count (see client.ts). */
    clientId,
    /** Seconds until another attempt is allowed, or 0 if not throttled. */
    throttled(c: Context): number {
      resetWindowIfDue();
      const blocked = (fails.get(clientId(c)) ?? 0) >= FAILS_PER_CLIENT || failsTotal >= FAILS_TOTAL;
      return blocked ? Math.ceil((windowStart + FAIL_WINDOW_MS - Date.now()) / 1000) : 0;
    },
    /**
     * Start a setup code check: seconds to wait when throttled, else 0. The
     * attempt is counted as a failure right away, so a burst of parallel
     * guesses cannot all get through before any of them is recorded.
     */
    attempt(c: Context): number {
      const wait = this.throttled(c);
      if (wait) return wait;
      const id = clientId(c);
      fails.set(id, (fails.get(id) ?? 0) + 1);
      failsTotal += 1;
      return 0;
    },
    /**
     * The attempt was right: take back that one attempt only. Earlier
     * failures stay counted.
     */
    succeeded(c: Context): void {
      const id = clientId(c);
      const n = fails.get(id) ?? 0;
      if (n > 1) fails.set(id, n - 1);
      else fails.delete(id);
      failsTotal = Math.max(0, failsTotal - 1);
    },
    login(c: Context, userId: number) {
      // Signing in again from the same browser replaces its previous session.
      const previous = cookieToken(c);
      if (previous) deleteViewerSession(db, tokenHash(previous));
      const token = randomBytes(32).toString("base64url");
      insertViewerSession(db, tokenHash(token), userId, nowSec() + SESSION_SEC);
      setCookie(c, cookieName(c), token, {
        httpOnly: true, path: "/", sameSite: "Lax", maxAge: SESSION_SEC, secure: isHttps(c),
      });
      // A session from before the prefix is never read over HTTPS: drop it.
      if (isHttps(c) && getCookie(c, COOKIE)) deleteCookie(c, COOKIE, { httpOnly: true, path: "/", sameSite: "Lax", secure: true });
    },
    logout(c: Context) {
      const token = cookieToken(c);
      if (token) deleteViewerSession(db, tokenHash(token));
      deleteCookie(c, cookieName(c), { httpOnly: true, path: "/", sameSite: "Lax", secure: isHttps(c) });
    },
    require: (async (c, next) => {
      const who = resolve(c);
      if (!who) return c.json({ error: "viewer login required" }, 401);
      c.set("userId", who.userId);
      c.set("account", who.account);
      c.set("signedInAt", who.signedInAt);
      await next();
    }) as MiddlewareHandler<ViewerEnv>,
  };
}

export type ViewerAuth = ReturnType<typeof createViewerAuth>;

export function bearerKey(c: Context): string | null {
  const m = (c.req.header("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}
