import type { MiddlewareHandler } from "hono";
import { AVATAR_HOSTS } from "./avatar.ts";
import type { ClientInfo } from "./client.ts";

// Browser features the dashboard never uses, off for the page and any frame.
const PERMISSIONS_POLICY = [
  "accelerometer", "browsing-topics", "camera", "display-capture", "geolocation", "gyroscope",
  "magnetometer", "microphone", "midi", "payment", "publickey-credentials-get", "usb",
].map((f) => `${f}=()`).join(", ");

// Pages load only the built bundle (no inline script or style attribute:
// Svelte sets styles through the CSSOM, which CSP allows), profile pictures
// from the avatar hosts, and the favicon as a data: URL. Sign-in leaves for
// GitHub by navigation; form-action also covers it should a form ever post.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  `img-src 'self' data: ${AVATAR_HOSTS.map((h) => `https://${h}`).join(" ")}`,
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self' https://github.com",
  "frame-ancestors 'none'",
].join("; ");

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
    // HTML only (index.html and the SPA fallback). In dev, Vite serves the
    // page itself on :5173 and only proxies /api here, so HMR is unaffected.
    if (c.res.headers.get("content-type")?.startsWith("text/html")) c.header("content-security-policy", CSP);
  };
}
