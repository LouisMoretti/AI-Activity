// Runs the dashboard state class (web/src/lib/dashboard.svelte.ts, Svelte 5
// runes) in node: compiled with svelte/compiler, with a fake browser
// (location, history, document) and a fake fetch answering per path.
import fs from "node:fs";
import path from "node:path";
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";
import { compileModule } from "svelte/compiler";

const LIB = new URL("../web/src/lib/", import.meta.url).pathname;
const BUILT = path.join(LIB, ".dashboard.test-build.js");

// --- fake browser -----------------------------------------------------------
const loc = { pathname: "/", search: "" };
const setUrl = (url) => {
  const u = new URL(url, "http://x");
  loc.pathname = u.pathname;
  loc.search = u.search;
};
let intervals = [];
globalThis.location = loc;
globalThis.history = { pushState: (_s, _t, url) => setUrl(url), replaceState: (_s, _t, url) => setUrl(url) };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.setInterval = (fn) => { intervals.push(fn); return intervals.length; };
globalThis.clearInterval = () => {};

/** path → response: a JSON body, a status number, or a function of the call count. */
let routes = {};
const calls = [];
globalThis.fetch = async (url) => {
  const p = String(url);
  calls.push(p);
  const key = Object.keys(routes).find((k) => p === k || p.startsWith(k + "?") || (k.endsWith("*") && p.startsWith(k.slice(0, -1))));
  let r = key === undefined ? 404 : routes[key];
  if (typeof r === "function") r = r(p);
  if (r instanceof Error) throw r;
  const status = typeof r === "number" ? r : 200;
  return { status, ok: status < 400, json: async () => (typeof r === "number" ? {} : r) };
};

const settle = async (ms = 5000) => {
  // load() is a chain of awaits (and a refresh on a ready page never leaves
  // "ready"), so a fixed sleep cannot tell when it landed: wait until no
  // fetch starts anymore instead. The fake fetch resolves immediately, so a
  // quiet window means every chained reload finished.
  const end = Date.now() + ms;
  for (;;) {
    const n = calls.length;
    await new Promise((r) => setTimeout(r, 50));
    if (calls.length === n) return;
    assert.ok(Date.now() <= end, "fetches never settled");
  }
};
const me = { id: 1, username: "me", display_name: "Me", avatar_url: null, is_admin: false };
const signedIn = { authenticated: true, user: me, setup_required: false, signup_open: true };
const signedOut = { authenticated: false, user: null, setup_required: false, signup_open: true };
const emptySummary = { tool: null, day: "2026-09-25", total: { tokens: 0, sessions: 0, events: 0, by_model: [], by_model_others_sessions: 0, by_tool: [] }, today: { tokens: 0, sessions: 0, events: 0, by_model: [], by_model_others_sessions: 0, by_tool: [] }, provenance: "" };
const profileRoutes = (name, sessions = { sessions: [], total: 0, provenance: "" }) => ({
  [`/api/u/${name}`]: { username: name, display_name: name, avatar_url: null },
  [`/api/u/${name}/summary`]: emptySummary,
  [`/api/u/${name}/activity`]: { days: [], provenance: "" },
  [`/api/u/${name}/quotas`]: { quotas: [], provenance: "" },
  [`/api/u/${name}/sessions`]: sessions,
});

let Dashboard, api;
before(async () => {
  const ts = fs.readFileSync(path.join(LIB, "dashboard.svelte.ts"), "utf8");
  const { js } = compileModule(stripTypeScriptTypes(ts), { filename: "dashboard.svelte.js", generate: "client" });
  fs.writeFileSync(BUILT, js.code);
  ({ Dashboard } = await import(BUILT));
  ({ api } = await import(path.join(LIB, "api.ts")));
});
after(() => fs.rmSync(BUILT, { force: true }));
beforeEach(() => { routes = {}; calls.length = 0; intervals = []; });

/** A dashboard opened at url, started, and settled. */
async function open(url, extra = {}) {
  setUrl(url);
  routes = { "/api/auth/status": signedIn, ...extra };
  const dash = new Dashboard();
  const stop = dash.start();
  await settle();
  return { dash, stop, tick: () => intervals.at(-1)() };
}

describe("dashboard state", () => {
  test("a malformed profile link shows 'missing' instead of crashing", async () => {
    const { dash, stop } = await open("/u/%ZZ", { "/api/u/%25ZZ*": 404 });
    assert.equal(dash.route.username, "%ZZ");
    assert.equal(dash.status, "missing");
    stop();
  });

  test("any page that could not reach the server retries on the next tick", async () => {
    const { dash, stop, tick } = await open("/leaderboard");
    routes["/api/auth/status"] = new TypeError("network down");
    dash.go("/settings");
    await settle();
    assert.equal(dash.status, "error");
    routes["/api/auth/status"] = signedIn;
    tick();
    await settle();
    assert.equal(dash.status, "ready");
    stop();
  });

  test("a rate-limited refresh keeps the page as it was; a first load shows the error", async () => {
    const { dash, stop, tick } = await open("/u/me", profileRoutes("me"));
    assert.equal(dash.status, "ready");
    const shown = dash.vm;
    routes["/api/u/me/summary"] = 429;
    tick();
    await settle();
    assert.equal(dash.status, "ready");
    assert.equal(dash.vm, shown);
    stop();
    const first = await open("/u/me", { ...profileRoutes("me"), "/api/u/me/summary": 429 });
    assert.equal(first.dash.status, "error");
    first.stop();
  });

  test("a 401 on a page that needs the session sends back to sign-in, then here", async () => {
    const { dash, stop } = await open("/settings", { "/api/devices": 401 });
    assert.equal(dash.status, "ready");
    // The session ended elsewhere: the server now says signed out, too.
    routes["/api/auth/status"] = signedOut;
    await assert.rejects(api.devices());
    await settle();
    assert.equal(dash.account, null);
    assert.equal(loc.pathname + loc.search, `/?next=${encodeURIComponent("/settings")}`);
    assert.equal(dash.status, "signed-out");
    stop();
  });

  test("opening a protected page signed out preserves its query for sign-in", async () => {
    const { stop } = await open("/settings?demo=1", { "/api/auth/status": signedOut });
    assert.equal(loc.pathname + loc.search, `/?next=${encodeURIComponent("/settings?demo=1")}`);
    stop();
  });

  test("a lost session preserves the query through sign-in", async () => {
    const { dash, stop } = await open("/u/me?demo=1", profileRoutes("me"));
    routes["/api/devices"] = 401;
    routes["/api/auth/status"] = signedOut;
    await assert.rejects(api.devices());
    await settle();
    assert.equal(loc.pathname + loc.search, `/?next=${encodeURIComponent("/u/me?demo=1")}`);

    routes["/api/auth/status"] = signedIn;
    routes["/api/auth/login"] = {};
    assert.equal(await dash.login("me", "secret"), null);
    await settle();
    assert.equal(loc.pathname + loc.search, "/u/me?demo=1");
    assert.equal(dash.vm.demo, true);
    stop();
  });

  test("a wrong password is not a lost session", async () => {
    const { dash, stop } = await open("/", { "/api/auth/status": signedOut, "/api/auth/login": 401 });
    assert.equal(await dash.login("me", "nope"), "Wrong username or password.");
    assert.equal(dash.status, "signed-out");
    stop();
  });

  test("signing in at /?demo=1 preserves demo through the profile redirect", async () => {
    const { dash, stop } = await open("/?demo=1", {
      ...profileRoutes("me"),
      "/api/auth/status": signedOut,
      "/api/auth/login": {},
    });
    routes["/api/auth/status"] = signedIn;
    assert.equal(await dash.login("me", "secret"), null);
    await settle();
    assert.equal(loc.pathname + loc.search, "/u/me?demo=1");
    assert.equal(dash.vm.demo, true);
    stop();
  });

  test("sign-in rejects external and protocol-relative return destinations", async () => {
    for (const next of ["https://example.com/away", "//example.com/away"]) {
      const { dash, stop } = await open(`/?next=${encodeURIComponent(next)}`, {
        ...profileRoutes("me"),
        "/api/auth/status": signedOut,
        "/api/auth/login": {},
      });
      routes["/api/auth/status"] = signedIn;
      assert.equal(await dash.login("me", "secret"), null);
      await settle();
      assert.equal(loc.pathname + loc.search, "/u/me");
      stop();
    }
  });

  test("the home link goes straight to your profile when signed in", async () => {
    const { dash, stop } = await open("/leaderboard", profileRoutes("me"));
    dash.go("/");
    assert.equal(loc.pathname, "/u/me");
    stop();
  });

  test("?demo=1 only lasts while it is in the address", async () => {
    const { dash, stop } = await open("/u/me?demo=1", profileRoutes("me"));
    assert.equal(dash.vm.demo, true);
    assert.deepEqual(dash.vm.antigravity.pools.map(p => p.windows.map(w => w.pct)), [[42, 68], [19, 32]]);
    const ids = dash.vm.sessions.map(s => s.id.slice(0, 8));
    assert.equal(dash.vm.sessions.filter(s => s.tool === "antigravity").length, 2);
    assert.equal(dash.vm.opencode.today.tokens, 0);
    assert.equal(dash.vm.opencode.today.sessions, 0);
    assert.equal(dash.vm.opencode.today.calls, 0);
    assert.equal(dash.vm.opencode.recent.length, 1, "demo covers history without use today");
    assert.equal(new Set(ids).size, ids.length, "demo ids differ in what the list shows");
    assert.ok(dash.vm.stats.today.byTool.some(r => r.name === "antigravity" && r.value > 0));
    for (const figure of [dash.vm.stats.today, dash.vm.stats.total, dash.vm.stats.sessions]) {
      assert.equal(new Set(figure.byModel.map(r => r.name)).size, figure.byModel.length);
    }
    dash.go("/leaderboard");
    await settle();
    dash.openProfile("me");
    await settle();
    assert.equal(dash.demo, false);
    assert.equal(dash.vm.demo, false);
    assert.deepEqual(dash.vm.antigravity.pools.map(p => p.windows.map(w => w.pct)), [[null, null], [null, null]]);
    assert.ok(!dash.vm.sessions.some(s => s.id.startsWith("demo-")));
    stop();
  });

  test("a session that moves between two pages is listed once", async () => {
    const s = (id, t) => ({ session_id: id, tool: "claude-code", tokens: 1, last_seen: t, events: 1, model: null, context_used_pct: null, context_window_size: null });
    const page1 = Array.from({ length: 200 }, (_, i) => s(`s${i}`, 1000 - i));
    // s150 became active between the two requests: it is on page 2 as well.
    const page2 = [s("s150", 2000), ...Array.from({ length: 9 }, (_, i) => s(`t${i}`, 10 - i))];
    const { dash, stop } = await open("/u/me", {
      ...profileRoutes("me"),
      "/api/u/me/sessions": (p) => ({ sessions: p.includes("offset=0") ? page1 : page2, total: 210, provenance: "" }),
    });
    for (let i = 0; i < 20; i++) dash.showMoreSessions();
    await settle();
    await settle();
    const ids = dash.vm.sessions.map((x) => x.id ?? x.session_id);
    assert.equal(new Set(ids).size, ids.length);
    stop();
  });

  test("navigating loads the new page once", async () => {
    const { dash, stop } = await open("/u/me", profileRoutes("me"));
    const before = calls.filter((c) => c === "/api/auth/status").length;
    dash.go("/leaderboard");
    await settle();
    assert.equal(calls.filter((c) => c === "/api/auth/status").length, before + 1);
    stop();
  });
});
