import type { Context, MiddlewareHandler } from "hono";
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
