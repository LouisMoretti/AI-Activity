import { Hono } from "hono";
import type { AuthStatus } from "../../shared/types.ts";
import { accountsExist, findUserByUsername } from "../db/queries.ts";
import type { DB } from "../db/schema.ts";
import { readJson } from "../lib/http.ts";
import { PASSWORD_MAX, verifyPassword } from "../lib/passwords.ts";
import type { ViewerAuth } from "../lib/viewer-auth.ts";

export function authRoutes(db: DB, auth: ViewerAuth) {
  return new Hono()
    .get("/status", (c) => {
      const who = auth.resolve(c);
      return c.json<AuthStatus>({
        locked: accountsExist(db),
        authenticated: Boolean(who),
        user: who?.account ?? null,
      });
    })
    .post("/login", async (c) => {
      const body = await readJson(c);
      const username = typeof body.username === "string" ? body.username.trim() : "";
      const password = typeof body.password === "string" ? body.password.slice(0, PASSWORD_MAX + 1) : "";
      const wait = auth.throttled(c);
      if (wait) {
        c.header("retry-after", String(wait));
        return c.json({ error: "too many failed attempts, try again later" }, 429);
      }
      if (!accountsExist(db)) return c.json({ error: "no accounts yet: the dashboard is open" }, 400);
      const user = username ? findUserByUsername(db, username) : null;
      const usable = user && !user.disabled ? user.password_hash : null;
      // Always hash, even for unknown users, so timing does not reveal them.
      const ok = await verifyPassword(password, usable);
      auth.record(c, ok);
      if (!ok || !user) return c.json({ error: "invalid username or password" }, 401);
      auth.login(c, user.id);
      return c.json({ ok: true });
    })
    .post("/logout", (c) => {
      auth.logout(c);
      return c.json({ ok: true });
    });
}
