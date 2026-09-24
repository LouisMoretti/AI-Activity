import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

const COOKIE = "dash_session";

/**
 * Shared-password viewer sessions for the testing phase (in memory, reset
 * on restart). With no password configured, the dashboard is open.
 */
export function createViewerAuth(password: string) {
  const sessions = new Set<string>();

  const isAuthed = (c: Context): boolean => {
    if (!password) return true;
    const token = getCookie(c, COOKIE);
    return Boolean(token && sessions.has(token));
  };

  return {
    locked: Boolean(password),
    isAuthed,
    check: (candidate: string) => !password || candidate === password,
    login(c: Context) {
      const token = randomUUID();
      sessions.add(token);
      setCookie(c, COOKIE, token, { httpOnly: true, path: "/", sameSite: "Lax", maxAge: 2592000 });
    },
    logout(c: Context) {
      const token = getCookie(c, COOKIE);
      if (token) sessions.delete(token);
      deleteCookie(c, COOKIE, { httpOnly: true, path: "/", sameSite: "Lax" });
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
