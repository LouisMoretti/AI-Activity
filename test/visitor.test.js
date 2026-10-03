// The browser's analytics id (web/src/lib/visitor.ts), on a fake localStorage.
import test from "node:test";
import assert from "node:assert/strict";
import { markSignIn, takeSignIn, visitorId } from "../web/src/lib/visitor.ts";

const DAY = 86400_000;
const store = new Map();
// Node may define its own localStorage (getter only): replace it outright.
const setStorage = (value) => Object.defineProperty(globalThis, "localStorage", { value, configurable: true, writable: true });
const fake = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
setStorage(fake);

test("one random id per browser, kept 13 months, then replaced", () => {
  const now = Date.UTC(2026, 9, 2);
  const id = visitorId(now);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(visitorId(now + 394 * DAY), id);
  const next = visitorId(now + 395 * DAY);
  assert.notEqual(next, id);
  assert.equal(visitorId(now + 396 * DAY), next);
  store.set("ai-activity:visitor", "{broken");
  assert.match(visitorId(now), /^[0-9a-f]{32}$/);
});

test("no storage: no id (the server falls back to a daily hash)", () => {
  setStorage({ getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("SecurityError"); } });
  try {
    assert.equal(visitorId(), null);
  } finally {
    setStorage(fake);
  }
});

test("a sign-in started in this tab marks its return and provider once, for 10 minutes", () => {
  const session = new Map();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, writable: true, value: {
    getItem: (k) => session.get(k) ?? null, setItem: (k, v) => session.set(k, String(v)), removeItem: (k) => session.delete(k),
  } });
  const now = Date.UTC(2026, 9, 2);
  assert.equal(takeSignIn(now), null);
  markSignIn("github.com", now);
  assert.equal(takeSignIn(now + 60_000), "github.com", "the provider, though the return has no referrer");
  assert.equal(takeSignIn(now + 60_000), null, "once");
  markSignIn("github.com", now);
  assert.equal(takeSignIn(now + 11 * 60_000), null, "abandoned sign-in");
  session.set("ai-activity:signing-in", String(now)); // an older tab's mark: no provider
  assert.equal(takeSignIn(now + 60_000), null);
});
