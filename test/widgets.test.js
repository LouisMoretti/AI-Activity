import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { startServer, req, register, newDevice, event, codexResponse } from "./helpers.js";
import { DEFAULT_ROWS } from "../shared/types.ts";

test("profile rows carry tools, views and ratios; only the owner can edit them", async () => {
  const srv = await startServer();
  try {
    const bob = (await register(srv.base, "widgetbob")).cookie;
    const get = (path, cookie) => req(srv.base, "GET", path, cookie ? { cookie } : { anon: true });
    assert.deepEqual((await get("/api/u/admin/panels")).json.rows, DEFAULT_ROWS);
    assert.deepEqual((await req(srv.base, "GET", "/api/account/panels")).json.rows, DEFAULT_ROWS);
    assert.deepEqual((await get("/api/account/panels", bob)).json.rows, DEFAULT_ROWS);
    assert.equal((await get("/api/account/panels", null)).status, 401);

    const chosen = [
      { ratio: "half", panels: [
        { id: "claude-code", view: "activity" },
        { id: "claude-code", view: "quota" },
      ] },
      { ratio: "wide-right", panels: [{ id: "today-by-hour" }] },
      { ratio: "full", panels: [{ id: "best-day" }] },
    ];
    assert.deepEqual((await req(srv.base, "POST", "/api/account/panels", { body: { rows: chosen } })).json.rows, chosen);
    assert.deepEqual((await get("/api/u/ADMIN/panels")).json.rows, chosen);
    assert.deepEqual((await get("/api/u/widgetbob/panels")).json.rows, DEFAULT_ROWS);
    for (const rows of [
      [{ ratio: "full", panels: [{ id: "bad" }] }],
      [{ ratio: "half", panels: [{ id: "best-day" }, { id: "best-day" }] }],
      ["best-day"],
      [{ ratio: "full", panels: [{ id: "claude-code", view: "quota" }, { id: "codex", view: "quota" }] }],
      [{ ratio: "half", panels: [{ id: "claude-code", view: "bad" }] }],
      [{ ratio: "half", panels: [{ id: "opencode", view: "quota" }] }],
      [{ ratio: "half", panels: [{ id: "best-day", view: "activity" }] }],
      [{ ratio: "half", panels: [{ id: "best-day", private: "secret" }] }],
      [{ ratio: "diagonal", panels: [{ id: "best-day" }] }],
      [{ ratio: "half", panels: [{ id: "best-day" }, { id: "best-day", view: "quota" }, { id: "codex", view: "quota" }] }],
      [{ id: "best-day", size: "small" }],
    ]) {
      assert.equal((await req(srv.base, "POST", "/api/account/panels", { body: { rows } })).status, 400);
    }
    assert.deepEqual((await get("/api/u/admin/panels")).json.rows, chosen);
    assert.deepEqual((await req(srv.base, "POST", "/api/account/panels", { body: { rows: [] }, cookie: bob })).json.rows, []);
    assert.deepEqual((await get("/api/u/widgetbob/panels")).json.rows, []);

    const db = new Database(srv.dbPath);
    try {
      db.prepare("UPDATE users SET panels = 'broken' WHERE username = 'admin'").run();
    } finally { db.close(); }
    assert.deepEqual((await get("/api/u/admin/panels")).json.rows, DEFAULT_ROWS);
    const flat = new Database(srv.dbPath);
    try {
      // The pre-rows flat list resets to the default rows on read.
      flat.prepare("UPDATE users SET panels = ? WHERE username = 'admin'")
        .run(JSON.stringify([{ id: "best-day", size: "small" }]));
    } finally { flat.close(); }
    assert.deepEqual((await get("/api/u/admin/panels")).json.rows, DEFAULT_ROWS);
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

test("rank panel matches the seven-day leaderboard without fetching its calendar", async () => {
  const srv = await startServer();
  try {
    const bob = (await register(srv.base, "rankbob")).cookie;
    const carl = (await register(srv.base, "rankcarl")).cookie;
    const devices = [
      (await newDevice(srv.base)).key,
      (await newDevice(srv.base, "bob-device", bob)).key,
      (await newDevice(srv.base, "carl-device", carl)).key,
    ];
    for (const [i, tokens] of [100, 200, 250].entries()) {
      const result = await req(srv.base, "POST", "/api/ingest/claude-code", {
        key: devices[i], body: event({ event_id: `msg_rank_${i}`, usage: { input_tokens: tokens } }),
      });
      assert.equal(result.status, 200);
    }
    const board = (await req(srv.base, "GET", "/api/leaderboard?days=7", { anon: true })).json;
    const rank = (await req(srv.base, "GET", "/api/u/rankbob/rank", { anon: true })).json;
    assert.equal(board.entries[rank.rank - 1].username, "rankbob");
    assert.deepEqual([rank.rank, rank.accounts, rank.tokens], [2, 3, 200]);
    assert.deepEqual(rank.neighbor, { username: "rankcarl", tokens: 250, direction: "behind" });
  } finally { await srv.stop(); }
});
