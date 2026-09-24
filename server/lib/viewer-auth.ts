import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

const COOKIE = "dash_session";
const SESSION_SEC = 30 * 86400;

/** Failed logins allowed per client, and in total, within one window. */
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAILS_PER_CLIENT = 10;
const FAILS_TOTAL = 50;

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Behind the Cloudflare tunnel every request comes from localhost, and
 * Cloudflare sets CF-Connecting-IP to the real client address.
 */
function clientId(c: Context): string {
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
 * Shared-password viewer sessions for the testing phase (in memory, reset
 * on restart). With no password configured, the dashboard is open.
 */
export function createViewerAuth(password: string) {
  const sessions = new Map<string, number>(); // token → expiry (ms)
  const expected = digest(password);
  let fails = new Map<string, number>(); // client → failures in window
  let failsTotal = 0;
  let windowStart = Date.now();

  const resetWindowIfDue = () => {
    if (Date.now() - windowStart < FAIL_WINDOW_MS) return;
    fails = new Map();
    failsTotal = 0;
    windowStart = Date.now();
  };

  const isAuthed = (c: Context): boolean => {
    if (!password) return true;
    const token = getCookie(c, COOKIE);
    const expires = token ? sessions.get(token) : undefined;
    if (expires === undefined) return false;
    if (expires > Date.now()) return true;
    sessions.delete(token!);
    return false;
  };

  return {
    locked: Boolean(password),
    isAuthed,
    /** Seconds until another attempt is allowed, or 0 if not throttled. */
    throttled(c: Context): number {
      resetWindowIfDue();
      const blocked = (fails.get(clientId(c)) ?? 0) >= FAILS_PER_CLIENT || failsTotal >= FAILS_TOTAL;
      return blocked ? Math.ceil((windowStart + FAIL_WINDOW_MS - Date.now()) / 1000) : 0;
    },
    /** Constant-time comparison; records failures for throttling. */
    check(c: Context, candidate: string): boolean {
      if (!password) return true;
      const ok = timingSafeEqual(digest(candidate), expected);
      if (ok) {
        fails.delete(clientId(c));
      } else {
        fails.set(clientId(c), (fails.get(clientId(c)) ?? 0) + 1);
        failsTotal += 1;
      }
      return ok;
    },
    login(c: Context) {
      const now = Date.now();
      for (const [t, exp] of sessions) if (exp <= now) sessions.delete(t);
      const token = randomUUID();
      sessions.set(token, now + SESSION_SEC * 1000);
      setCookie(c, COOKIE, token, {
        httpOnly: true, path: "/", sameSite: "Lax", maxAge: SESSION_SEC, secure: isHttps(c),
      });
    },
    logout(c: Context) {
      const token = getCookie(c, COOKIE);
      if (token) sessions.delete(token);
      deleteCookie(c, COOKIE, { httpOnly: true, path: "/", sameSite: "Lax", secure: isHttps(c) });
    },
    require: (async (c, next) => {
      if (!isAuthed(c)) return c.json({ error: "viewer login required" }, 401);
      await next();
    }) as MiddlewareHandler,
  };
}

export type ViewerAuth = ReturnType<typeof createViewerAuth>;

export function bearerKey(c: Context): string | null {
  const m = (c.req.header("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}
