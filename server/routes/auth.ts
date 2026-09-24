import { Hono } from "hono";
import type { AuthStatus } from "../../shared/types.ts";
import type { ViewerAuth } from "../lib/viewer-auth.ts";

export function authRoutes(auth: ViewerAuth) {
  return new Hono()
    .get("/status", (c) =>
      c.json<AuthStatus>({ locked: auth.locked, authenticated: auth.isAuthed(c) }))
    .post("/login", async (c) => {
      let password = "";
      try {
        password = String(JSON.parse((await c.req.text()) || "{}").password || "");
      } catch { /* treated as empty password */ }
      const wait = auth.throttled(c);
      if (wait) {
        c.header("retry-after", String(wait));
        return c.json({ error: "too many failed attempts, try again later" }, 429);
      }
      if (!auth.check(c, password)) return c.json({ error: "invalid password" }, 401);
      auth.login(c);
      return c.json({ ok: true });
    })
    .post("/logout", (c) => {
      auth.logout(c);
      return c.json({ ok: true });
    });
}
