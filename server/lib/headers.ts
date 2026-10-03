import type { MiddlewareHandler } from "hono";
import type { ClientInfo } from "./client.ts";

// Browser features the dashboard never uses, off for the page and any frame.
const PERMISSIONS_POLICY = [
  "accelerometer", "browsing-topics", "camera", "display-capture", "geolocation", "gyroscope",
  "magnetometer", "microphone", "midi", "payment", "publickey-credentials-get", "usb",
].map((f) => `${f}=()`).join(", ");

/**
 * Standard security headers on every response (pages, assets, API, install
 * scripts, errors). HSTS only when the browser came over HTTPS (the same
 * check as the Secure cookie): plain HTTP in dev never pins a host to HTTPS.
 */
export function securityHeaders(client: ClientInfo): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header("x-frame-options", "DENY");
    c.header("permissions-policy", PERMISSIONS_POLICY);
    if (client.isHttps(c)) c.header("strict-transport-security", "max-age=31536000");
  };
}
