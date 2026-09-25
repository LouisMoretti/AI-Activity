import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { clientInfo, parseTrustProxy } from "../server/lib/client.ts";

/** What the server would see from `peer` with these headers, behind TRUST_PROXY=`trust`. */
async function seen(trust, peer, headers = {}, url = "http://app:3000/x") {
  const { clientId, isHttps } = clientInfo(parseTrustProxy(trust));
  const app = new Hono().get("/x", (c) => c.json({ id: clientId(c), https: isHttps(c) }));
  const incoming = { socket: { remoteAddress: peer, remotePort: 40000, remoteFamily: peer.includes(":") ? "IPv6" : "IPv4" } };
  return (await app.request(url, { headers }, { incoming })).json();
}

describe("client address behind proxies", () => {
  test("TRUST_PROXY accepts addresses and CIDR ranges, and refuses anything else", () => {
    assert.doesNotThrow(() => parseTrustProxy(""));
    assert.doesNotThrow(() => parseTrustProxy(undefined));
    assert.doesNotThrow(() => parseTrustProxy(" 172.29.94.0/24, 10.0.0.2 ,fd00::/8"));
    for (const bad of ["caddy", "10.0.0.0/33", "10.0.0.0/8/1", "10.0.0/8", "::1/129", "10.0.0.0/x"]) {
      assert.throws(() => parseTrustProxy(bad), /TRUST_PROXY/, bad);
    }
  });

  test("from a trusted proxy: the address it added (the last X-Forwarded-For entry)", async () => {
    const trust = "172.29.94.0/24";
    assert.equal((await seen(trust, "172.29.94.3", { "x-forwarded-for": "203.0.113.7" })).id, "203.0.113.7");
    // A client can put anything first; only the proxy's own entry counts.
    assert.equal((await seen(trust, "172.29.94.3", { "x-forwarded-for": "1.2.3.4, 203.0.113.7" })).id, "203.0.113.7");
    assert.equal((await seen(trust, "::ffff:172.29.94.3", { "x-forwarded-for": "2001:db8::5" })).id, "2001:db8::5");
    // No usable header: the proxy itself.
    assert.equal((await seen(trust, "172.29.94.3", { "x-forwarded-for": "garbage" })).id, "172.29.94.3");
    assert.equal((await seen(trust, "172.29.94.3")).id, "172.29.94.3");
  });

  test("from anyone else, forwarding headers are ignored", async () => {
    const trust = "172.29.94.0/24";
    const h = { "x-forwarded-for": "203.0.113.7", "cf-connecting-ip": "203.0.113.8", "x-forwarded-proto": "https" };
    assert.deepEqual(await seen(trust, "192.168.1.20", h), { id: "192.168.1.20", https: false });
    assert.deepEqual(await seen("", "172.29.94.3", h), { id: "172.29.94.3", https: false });
  });

  test("from localhost (quick tunnel, Vite proxy): CF-Connecting-IP, as before", async () => {
    assert.equal((await seen("", "127.0.0.1", { "cf-connecting-ip": "203.0.113.8" })).id, "203.0.113.8");
    assert.equal((await seen("", "::ffff:127.0.0.1", {})).id, "127.0.0.1");
    assert.equal((await seen("", "::1", { "x-forwarded-for": "203.0.113.7" })).id, "::1");
  });

  test("X-Forwarded-Proto marks HTTPS only from localhost or a trusted proxy", async () => {
    const https = { "x-forwarded-proto": "https" };
    assert.equal((await seen("172.29.94.0/24", "172.29.94.3", https)).https, true);
    assert.equal((await seen("", "127.0.0.1", https)).https, true);
    assert.equal((await seen("", "10.1.1.1", https)).https, false);
    assert.equal((await seen("", "10.1.1.1", {}, "https://example.test/x")).https, true);
  });
});
