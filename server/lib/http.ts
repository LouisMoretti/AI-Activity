import type { Context, MiddlewareHandler } from "hono";
import type { DB } from "../db/schema.ts";
import { HTTPException } from "hono/http-exception";

/** Parse a JSON body, turning malformed input into a 400. */
export async function readJson(c: Context): Promise<Record<string, unknown>> {
  const raw = (await c.req.text()) || "{}";
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new HTTPException(400, { message: "invalid JSON" });
  }
}

/** Clamp an integer query parameter into [min, max], with a default. */
export function intParam(c: Context, name: string, def: number, min: number, max: number): number {
  return Math.min(Math.max(Number(c.req.query(name)) || def, min), max);
}

/**
 * Reject bodies over maxBytes with a 413. Unlike hono/body-limit, the rest
 * of an oversized body is drained (and discarded) before responding, so the
 * client's keep-alive connection stays usable instead of being reset.
 */
export function limitBody(maxBytes: number): MiddlewareHandler {
  return async (c, next) => {
    const body = c.req.raw.body;
    if (!body) return next();
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size <= maxBytes) chunks.push(value);
    }
    if (size > maxBytes) return c.json({ error: "body too large" }, 413);
    c.req.raw = new Request(c.req.raw, {
      body: new Blob(chunks as BlobPart[]),
      duplex: "half",
    } as RequestInit);
    await next();
  };
}

const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 500;

/**
 * Cache successful GET answers of public read routes (profiles, leaderboard)
 * until the database changes, or for 30 s at most (time-based windows such
 * as "today" and "last 30 days" move on their own). Every open dashboard
 * polls every 15 s, so an idle server answers from memory. "Changed" is
 * total_changes() for this server's own writes and PRAGMA data_version for
 * writes from another connection (the npm run user / gen-key CLI).
 */
export function readCache(db: DB): MiddlewareHandler {
  const cache = new Map<string, { version: string; at: number; body: string }>();
  const changes = db.prepare("SELECT total_changes() AS n");
  return async (c, next) => {
    if (c.req.method !== "GET") return next();
    const url = new URL(c.req.url);
    const key = url.pathname + url.search;
    const version = `${(changes.get() as { n: number }).n}:${db.pragma("data_version", { simple: true })}`;
    const hit = cache.get(key);
    if (hit && hit.version === version && Date.now() - hit.at < CACHE_TTL_MS) {
      return c.body(hit.body, 200, { "content-type": "application/json" });
    }
    await next();
    if (c.res.status !== 200) return;
    cache.delete(key);
    cache.set(key, { version, at: Date.now(), body: await c.res.clone().text() });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  };
}
