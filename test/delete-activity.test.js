// Runs the Settings "Delete activity" flow (web/src/lib/delete-activity.svelte.ts,
// Svelte 5 runes) in node, compiled with svelte/compiler, against a fake fetch.
import fs from "node:fs";
import path from "node:path";
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";
import { compileModule } from "svelte/compiler";

const LIB = new URL("../web/src/lib/", import.meta.url).pathname;
const BUILT = path.join(LIB, ".delete-activity.test-build.js");

/** The next answer of the fake server: [status, body], or an Error to throw. */
let answer;
const posts = [];
globalThis.fetch = async (url, init) => {
  posts.push({ url: String(url), body: JSON.parse(init.body) });
  if (answer instanceof Error) throw answer;
  const [status, body] = answer;
  return { status, ok: status < 400, json: async () => body };
};

let DeleteActivity;
before(async () => {
  const ts = fs.readFileSync(path.join(LIB, "delete-activity.svelte.ts"), "utf8");
  const { js } = compileModule(stripTypeScriptTypes(ts), { filename: "delete-activity.svelte.js", generate: "client" });
  fs.writeFileSync(BUILT, js.code);
  ({ DeleteActivity } = await import(BUILT));
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
  test("confirming needs the password and the exact phrase", async () => {
    const { flow } = opened();
    assert.equal(flow.step, "confirming");
    assert.equal(flow.ready, false);
    flow.password = "secret-pass";
    flow.phrase = "delete my";
    assert.equal(flow.ready, false);
    await flow.confirm();
    assert.equal(posts.length, 0);
    flow.phrase = "  Delete My Activity ";
    assert.equal(flow.ready, true);
    flow.password = "";
    assert.equal(flow.ready, false);
  });

  test("cancelling sends nothing and forgets what was typed", async () => {
    const { flow, reloads } = opened();
    flow.password = "secret-pass";
    flow.phrase = "delete my activity";
    flow.cancel();
    assert.equal(flow.step, "closed");
    assert.deepEqual([flow.password, flow.phrase, flow.error], ["", "", null]);
    await flow.confirm();
    assert.deepEqual([posts.length, reloads.n], [0, 0]);
  });

  test("success reports what was deleted and reloads the dashboard", async () => {
    const { flow, reloads } = opened();
    flow.password = "secret-pass";
    flow.phrase = "delete my activity";
    const pending = flow.confirm();
    assert.equal(flow.step, "busy");
    await pending;
    assert.deepEqual(posts, [{ url: "/api/account/delete-activity", body: { password: "secret-pass", confirm: "delete my activity" } }]);
    assert.equal(flow.step, "done");
    assert.deepEqual(flow.deleted, { events: 3, quotas: 1 });
    assert.deepEqual([flow.password, flow.phrase], ["", ""]);
    assert.equal(reloads.n, 1);
    // Opening it again starts over.
    flow.open();
    assert.deepEqual([flow.step, flow.deleted], ["confirming", null]);
  });

  test("a failure shows the server's message, keeps the form and asks for the password again", async () => {
    const { flow, reloads } = opened();
    answer = [400, { error: "password is wrong" }];
    flow.password = "wrong-pass";
    flow.phrase = "delete my activity";
    await flow.confirm();
    assert.deepEqual([flow.step, flow.error, flow.password, flow.phrase], ["confirming", "password is wrong", "", "delete my activity"]);
    assert.equal(reloads.n, 0);
    answer = new TypeError("network down");
    flow.password = "secret-pass";
    await flow.confirm();
    assert.deepEqual([flow.step, flow.error], ["confirming", "network down"]);
    answer = [200, { ok: true, deleted: { events: 0, quotas: 0 } }];
    flow.password = "secret-pass";
    await flow.confirm();
    assert.deepEqual([flow.step, flow.error, reloads.n], ["done", null, 1]);
  });
});
