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
 * Requests that change something must be JSON, from this site. A page on
 * another site can make a browser POST a plain HTML form (text/plain can
 * carry a valid JSON body) with no CORS preflight: without this check it
 * could sign the visitor in to an account of its choosing, or sign them
 * out. application/json cannot be sent cross-site without a preflight,
 * which this server never answers.
 */
export const jsonOnly: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  if (c.req.header("sec-fetch-site") === "cross-site") return c.json({ error: "cross-site request refused" }, 403);
  const type = (c.req.header("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return c.json({ error: "send the body as application/json" }, 415);
  await next();
};

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
