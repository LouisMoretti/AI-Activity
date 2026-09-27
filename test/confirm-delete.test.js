// Runs the Settings danger zone's flows (web/src/lib/confirm-delete.svelte.ts,
// Svelte 5 runes: "Delete activity" and "Delete my account") in node,
// compiled with svelte/compiler, against a fake fetch.
import fs from "node:fs";
import path from "node:path";
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";
import { compileModule } from "svelte/compiler";

const LIB = new URL("../web/src/lib/", import.meta.url).pathname;
const BUILT = path.join(LIB, ".confirm-delete.test-build.js");

/** The next answer of the fake server: [status, body], or an Error to throw. */
let answer;
const posts = [];
globalThis.fetch = async (url, init) => {
  posts.push({ url: String(url), body: JSON.parse(init.body) });
  if (answer instanceof Error) throw answer;
  const [status, body] = answer;
  return { status, ok: status < 400, json: async () => body };
};

let DeleteActivity, DeleteAccount;
before(async () => {
  const ts = fs.readFileSync(path.join(LIB, "confirm-delete.svelte.ts"), "utf8");
  const { js } = compileModule(stripTypeScriptTypes(ts), { filename: "confirm-delete.svelte.js", generate: "client" });
  fs.writeFileSync(BUILT, js.code);
  ({ DeleteActivity, DeleteAccount } = await import(BUILT));
});
after(() => fs.rmSync(BUILT, { force: true }));
beforeEach(() => { posts.length = 0; answer = [200, { ok: true, deleted: { events: 3, quotas: 1 } }]; });

/** A flow with its confirmation form open, and how many times it reloaded. */
function opened() {
  const reloads = { n: 0 };
  const flow = new DeleteActivity(() => { reloads.n += 1; });
  flow.open();
  return { flow, reloads };
}

describe("delete activity flow", () => {
  test("confirming needs the exact phrase", async () => {
    const { flow } = opened();
    assert.equal(flow.step, "confirming");
    assert.equal(flow.ready, false);
    flow.phrase = "delete my";
    assert.equal(flow.ready, false);
    await flow.confirm();
    assert.equal(posts.length, 0);
    flow.phrase = "  Delete My Activity ";
    assert.equal(flow.ready, true);
  });

  test("cancelling sends nothing and forgets what was typed", async () => {
    const { flow, reloads } = opened();
    flow.phrase = "delete my activity";
    flow.cancel();
    assert.equal(flow.step, "closed");
    assert.deepEqual([flow.phrase, flow.error, flow.reauth], ["", null, false]);
    await flow.confirm();
    assert.deepEqual([posts.length, reloads.n], [0, 0]);
  });

  test("success reports what was deleted and reloads the dashboard", async () => {
    const { flow, reloads } = opened();
    flow.phrase = "delete my activity";
    const pending = flow.confirm();
    assert.equal(flow.step, "busy");
    await pending;
    assert.deepEqual(posts, [{ url: "/api/account/delete-activity", body: { confirm: "delete my activity" } }]);
    assert.equal(flow.step, "done");
    assert.deepEqual(flow.deleted, { events: 3, quotas: 1 });
    assert.equal(flow.phrase, "");
    assert.equal(reloads.n, 1);
    // Opening it again starts over.
    flow.open();
    assert.deepEqual([flow.step, flow.deleted], ["confirming", null]);
  });

  test("a failure shows the server's message and keeps the form", async () => {
    const { flow, reloads } = opened();
    answer = [400, { error: 'type "delete my activity" to confirm' }];
    flow.phrase = "delete my activity";
    await flow.confirm();
    assert.deepEqual([flow.step, flow.error, flow.reauth, flow.phrase],
      ["confirming", 'type "delete my activity" to confirm', false, "delete my activity"]);
    assert.equal(reloads.n, 0);
    answer = new TypeError("network down");
    await flow.confirm();
    assert.deepEqual([flow.step, flow.error], ["confirming", "network down"]);
    answer = [200, { ok: true, deleted: { events: 0, quotas: 0 } }];
    await flow.confirm();
    assert.deepEqual([flow.step, flow.error, reloads.n], ["done", null, 1]);
  });

  test("an old sign-in asks to sign in with GitHub again, then confirming works", async () => {
    const { flow, reloads } = opened();
    answer = [403, { error: "sign in with GitHub again to confirm", reauth: true }];
    flow.phrase = "delete my activity";
    await flow.confirm();
    assert.deepEqual([flow.step, flow.error, flow.reauth], ["confirming", "sign in with GitHub again to confirm", true]);
    answer = [200, { ok: true, deleted: { events: 1, quotas: 0 } }];
    await flow.confirm();
    assert.deepEqual([flow.step, flow.reauth, reloads.n], ["done", false, 1]);
  });
});

describe("delete account flow", () => {
  /** A flow with its confirmation form open, and how many times it signed out. */
  function openedAccount() {
    const signOuts = { n: 0 };
    const flow = new DeleteAccount(() => { signOuts.n += 1; });
    flow.open();
    return { flow, signOuts };
  }

  test("confirming needs its own phrase", async () => {
    const { flow } = openedAccount();
    flow.phrase = "delete my activity";
    assert.equal(flow.ready, false);
    await flow.confirm();
    assert.equal(posts.length, 0);
    flow.phrase = "Delete my account";
    assert.equal(flow.ready, true);
  });

  test("cancelling sends nothing and forgets what was typed", async () => {
    const { flow, signOuts } = openedAccount();
    flow.phrase = "delete my account";
    flow.cancel();
    assert.deepEqual([flow.step, flow.phrase], ["closed", ""]);
    await flow.confirm();
    assert.deepEqual([posts.length, signOuts.n], [0, 0]);
  });

  test("success signs out", async () => {
    const { flow, signOuts } = openedAccount();
    answer = [200, { ok: true, deleted: { events: 3, quotas: 1, devices: 2 } }];
    flow.phrase = "delete my account";
    await flow.confirm();
    assert.deepEqual(posts, [{ url: "/api/account/delete", body: { confirm: "delete my account" } }]);
    assert.deepEqual([flow.step, flow.result, signOuts.n], ["done", { events: 3, quotas: 1, devices: 2 }, 1]);
  });

  test("the last admin's refusal is shown and nothing signs out", async () => {
    const { flow, signOuts } = openedAccount();
    answer = [409, { error: "you are the last admin: make another account admin first" }];
    flow.phrase = "delete my account";
    await flow.confirm();
    assert.deepEqual([flow.step, flow.error, flow.reauth, signOuts.n],
      ["confirming", "you are the last admin: make another account admin first", false, 0]);
  });
});
