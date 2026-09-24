import { createHash, randomBytes } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Account } from "../../shared/types.ts";
import { deleteViewerSession, insertViewerSession, toAccount, viewerSessionUser } from "../db/queries.ts";
import { nowSec, type DB } from "../db/schema.ts";

const COOKIE = "dash_session";
const SESSION_SEC = 30 * 86400;

/** Failed logins allowed per client, and in total, within one window. */
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAILS_PER_CLIENT = 10;
const FAILS_TOTAL = 50;

/** Hono env of every viewer route: who the request acts for. */
export type ViewerEnv = {
  Variables: {
    /** The signed-in viewer. */
    userId: number;
    account: Account;
  };
};

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Behind the Cloudflare tunnel every request comes from localhost, and
 * Cloudflare sets CF-Connecting-IP to the real client address.
 */
export function clientId(c: Context): string {
  const cf = c.req.header("cf-connecting-ip");
  if (cf) return cf;
  try {
    return getConnInfo(c).remote.address || "unknown";
  } catch {
    return "unknown";
  }
}

/** HTTPS as seen by the browser, including through the tunnel. */
const isHttps = (c: Context) =>
  new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";

/**
 * Per-user viewer sessions, stored hashed in SQLite so they survive a
 * restart. Every viewer API needs one: with no account yet, nothing is
 * readable until the first account is created (npm run user -- add).
 */
export function createViewerAuth(db: DB) {
  let fails = new Map<string, number>(); // client → failures in window
  let failsTotal = 0;
  let windowStart = Date.now();

  const resetWindowIfDue = () => {
    if (Date.now() - windowStart < FAIL_WINDOW_MS) return;
    fails = new Map();
    failsTotal = 0;
    windowStart = Date.now();
  };

  const cookieToken = (c: Context) => getCookie(c, COOKIE) || null;

  /** Who this request acts for, or null when it needs a login. */
  const resolve = (c: Context): { userId: number; account: Account } | null => {
    const token = cookieToken(c);
    const user = token ? viewerSessionUser(db, tokenHash(token)) : null;
    return user ? { userId: user.id, account: toAccount(user) } : null;
  };

  return {
    resolve,
    /** The current session's token hash (to keep it when signing out elsewhere). */
    sessionHash: (c: Context) => {
      const token = cookieToken(c);
      return token ? tokenHash(token) : null;
    },
    /** Seconds until another attempt is allowed, or 0 if not throttled. */
    throttled(c: Context): number {
      resetWindowIfDue();
      const blocked = (fails.get(clientId(c)) ?? 0) >= FAILS_PER_CLIENT || failsTotal >= FAILS_TOTAL;
      return blocked ? Math.ceil((windowStart + FAIL_WINDOW_MS - Date.now()) / 1000) : 0;
    },
    /** Count a login attempt for throttling. */
    record(c: Context, ok: boolean): void {
      resetWindowIfDue();
      const id = clientId(c);
      if (ok) {
        // That client was mistyping, not guessing: stop counting it globally.
        failsTotal = Math.max(0, failsTotal - (fails.get(id) ?? 0));
        fails.delete(id);
      } else {
        fails.set(id, (fails.get(id) ?? 0) + 1);
        failsTotal += 1;
      }
    },
    login(c: Context, userId: number) {
      // Signing in again from the same browser replaces its previous session.
      const previous = cookieToken(c);
      if (previous) deleteViewerSession(db, tokenHash(previous));
      const token = randomBytes(32).toString("base64url");
      insertViewerSession(db, tokenHash(token), userId, nowSec() + SESSION_SEC);
      setCookie(c, COOKIE, token, {
        httpOnly: true, path: "/", sameSite: "Lax", maxAge: SESSION_SEC, secure: isHttps(c),
      });
    },
    logout(c: Context) {
      const token = cookieToken(c);
      if (token) deleteViewerSession(db, tokenHash(token));
      deleteCookie(c, COOKIE, { httpOnly: true, path: "/", sameSite: "Lax", secure: isHttps(c) });
    },
    require: (async (c, next) => {
      const who = resolve(c);
      if (!who) return c.json({ error: "viewer login required" }, 401);
      c.set("userId", who.userId);
      c.set("account", who.account);
      await next();
    }) as MiddlewareHandler<ViewerEnv>,
  };
}

export type ViewerAuth = ReturnType<typeof createViewerAuth>;

export function bearerKey(c: Context): string | null {
  const m = (c.req.header("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}
