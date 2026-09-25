import net from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// "::ffff:10.0.0.2" (an IPv4 client on a dual-stack socket) → "10.0.0.2".
const plain = (ip: string) => (ip.startsWith("::ffff:") && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip);

/**
 * TRUST_PROXY: comma-separated addresses or CIDR ranges of the reverse proxy
 * in front of the server (Caddy in Docker). Throws on anything else, so a
 * typo stops the server at start instead of silently trusting nothing.
 */
export function parseTrustProxy(spec: string | undefined): net.BlockList {
  const list = new net.BlockList();
  for (const entry of (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [addr, bits, extra] = entry.split("/");
    const type = net.isIPv4(addr) ? "ipv4" : net.isIPv6(addr) ? "ipv6" : null;
    const prefix = bits === undefined ? (type === "ipv4" ? 32 : 128) : Number(bits);
    if (!type || extra !== undefined || !/^\d+$/.test(bits ?? "0") || prefix > (type === "ipv4" ? 32 : 128)) {
      throw new Error(`TRUST_PROXY: "${entry}" is not an IP address or CIDR range`);
    }
    list.addSubnet(addr, prefix, type);
  }
  return list;
}

/**
 * Who a request comes from, as far as the per-client limits can tell.
 *
 * - From localhost (the Cloudflare quick tunnel, the Vite dev proxy):
 *   CF-Connecting-IP, which Cloudflare sets to the real client address.
 * - From a trusted proxy (TRUST_PROXY): the last X-Forwarded-For address,
 *   the one that proxy added. Earlier ones come from the client and can be
 *   forged; Caddy replaces the header when the client is not a proxy it
 *   trusts, so it holds only the client's address anyway.
 * - Anyone else: the socket address. A client reaching the server directly
 *   (e.g. on the LAN) could otherwise send a new header on every request and
 *   escape the per-client limits.
 */
export function clientInfo(trusted: net.BlockList) {
  const peerOf = (c: Context) => {
    try {
      return plain(getConnInfo(c).remote.address || "unknown");
    } catch {
      return "unknown"; // not a Node socket (app.request in tests)
    }
  };
  const isTrusted = (peer: string) =>
    (net.isIPv4(peer) && trusted.check(peer, "ipv4")) || (net.isIPv6(peer) && trusted.check(peer, "ipv6"));
  const isLocal = (peer: string) => LOOPBACK.has(peer);

  return {
    clientId(c: Context): string {
      const peer = peerOf(c);
      if (isLocal(peer)) return c.req.header("cf-connecting-ip") || peer;
      if (isTrusted(peer)) {
        const last = plain(c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "");
        return net.isIP(last) ? last : peer;
      }
      return peer;
    },
    /** HTTPS as seen by the browser: X-Forwarded-Proto only from a local or trusted proxy. */
    isHttps(c: Context): boolean {
      if (new URL(c.req.url).protocol === "https:") return true;
      const peer = peerOf(c);
      return (isLocal(peer) || isTrusted(peer)) && c.req.header("x-forwarded-proto") === "https";
    },
  };
}

export type ClientInfo = ReturnType<typeof clientInfo>;
