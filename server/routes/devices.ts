import { Hono } from "hono";
import type { Device } from "../../shared/types.ts";
import { createDevice, listDevices, revokeDevice } from "../db/queries.ts";
import type { DB } from "../db/schema.ts";
import { readJson } from "../lib/http.ts";

export function deviceRoutes(db: DB, userId: () => number) {
  return new Hono()
    .get("/", (c) => c.json<{ devices: Device[] }>({ devices: listDevices(db, userId()) }))
    .post("/", async (c) => {
      const body = await readJson(c);
      const created = createDevice(db, {
        userId: userId(),
        name: String(body.name || "unnamed device").slice(0, 80),
      });
      // The full key is returned once and never stored in plain text.
      return c.json({ ok: true, id: created.id, key: created.key });
    })
    .post("/:id{[0-9]+}/revoke", (c) => {
      if (!revokeDevice(db, userId(), Number(c.req.param("id")))) {
        return c.json({ error: "device not found" }, 404);
      }
      return c.json({ ok: true });
    });
}
