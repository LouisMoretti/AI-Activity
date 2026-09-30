import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { startServer, req, register, newDevice, event, codexResponse } from "./helpers.js";
import { WIDGETS } from "../shared/types.ts";

test("profile widgets are owned by one account, public in saved order, and reject invalid lists", async () => {
  const srv = await startServer();
  try {
    const bob = (await register(srv.base, "widgetbob")).cookie;
    const get = (path, cookie) => req(srv.base, "GET", path, cookie ? { cookie } : { anon: true });
    assert.deepEqual((await get("/api/u/admin/widgets")).json.widgets, ["today-by-tool"]);
    assert.equal((await req(srv.base, "GET", "/api/account/widgets")).json.widgets[0], "today-by-tool");
    assert.equal((await get("/api/account/widgets", bob)).json.widgets[0], "today-by-tool");
    assert.equal((await get("/api/account/widgets", null)).status, 401);

    const chosen = ["leaderboard", "best-day", "today-by-hour"];
    assert.deepEqual((await req(srv.base, "POST", "/api/account/widgets", { body: { widgets: chosen } })).json.widgets, chosen);
    assert.deepEqual((await get("/api/u/ADMIN/widgets")).json.widgets, chosen);
    assert.deepEqual((await get("/api/u/widgetbob/widgets")).json.widgets, ["today-by-tool"]);
    for (const widgets of [["bad"], ["best-day", "best-day"], "best-day", [...WIDGETS, "bad"]]) {
      assert.equal((await req(srv.base, "POST", "/api/account/widgets", { body: { widgets } })).status, 400);
    }
    assert.deepEqual((await get("/api/u/admin/widgets")).json.widgets, chosen);
    assert.deepEqual((await req(srv.base, "POST", "/api/account/widgets", { body: { widgets: [] }, cookie: bob })).json.widgets, []);
    assert.deepEqual((await get("/api/u/widgetbob/widgets")).json.widgets, []);

    const db = new Database(srv.dbPath);
    try {
      db.prepare("UPDATE users SET widgets = 'broken' WHERE username = 'admin'").run();
    } finally { db.close(); }
    assert.deepEqual((await get("/api/u/admin/widgets")).json.widgets, ["today-by-tool"]);
  } finally { await srv.stop(); }
});

test("hourly widget uses event local hours and only the owner's today", async () => {
  const srv = await startServer();
  try {
    const key = (await newDevice(srv.base)).key;
    const now = Math.floor(Date.now() / 1000);
    const utcHour = new Date(now * 1000).getUTCHours();
    let offsetHours = 12 - utcHour;
    if (offsetHours > 12) offsetHours -= 24;
    if (offsetHours < -12) offsetHours += 24;
    const offset = offsetHours * 60;
    const post = (tool, id, occurred_at, utc_offset_min) => req(srv.base, "POST", `/api/ingest/${tool}`, {
      key, body: tool === "codex"
        ? codexResponse({ response_id: id, occurred_at, utc_offset_min, session_id: id })
        : event({ event_id: id, occurred_at, utc_offset_min, session_id: id }),
    });
    assert.equal((await post("claude-code", "msg_hour_11", now - 3600, offset)).status, 200);
    assert.equal((await post("codex", "resp_hour_12", now, offset)).status, 200);
    assert.equal((await post("codex", "resp_hour_yesterday", now - 13 * 3600, offset)).status, 200);
    const hours = (await req(srv.base, "GET", "/api/u/admin/hours", { anon: true })).json;
    assert.equal(hours.current_hour, 12);
    assert.equal(hours.day, new Date((now + offset * 60) * 1000).toISOString().slice(0, 10));
    assert.deepEqual(hours.hours.map(({ hour, tool, tokens }) => [hour, tool, tokens]),
      [[11, "claude-code", 180], [12, "codex", 340]]);
    assert.equal((await req(srv.base, "GET", "/api/u/unknown/hours", { anon: true })).status, 404);
  } finally { await srv.stop(); }
});
