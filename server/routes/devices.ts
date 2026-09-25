import { Hono } from "hono";
import type { Device } from "../../shared/types.ts";
import { countLiveDevices, createDevice, getDeviceKey, listDevices, revokeDevice } from "../db/queries.ts";
import type { DB } from "../db/schema.ts";
import { readJson } from "../lib/http.ts";
import { LIMITS } from "../lib/rate-limit.ts";
import type { ViewerEnv } from "../lib/viewer-auth.ts";

export function deviceRoutes(db: DB) {
  return new Hono<ViewerEnv>()
    .get("/", (c) => c.json<{ devices: Device[] }>({ devices: listDevices(db, c.get("userId")) }))
    .post("/", async (c) => {
      const body = await readJson(c);
      if (countLiveDevices(db, c.get("userId")) >= LIMITS.devicesPerAccount) {
        return c.json({ error: `at most ${LIMITS.devicesPerAccount} devices per account: revoke one first` }, 409);
      }
      const created = createDevice(db, {
        userId: c.get("userId"),
        name: (typeof body.name === "string" && body.name.trim()) ? body.name.trim().slice(0, 80) : "unnamed device",
      });
      return c.json({ ok: true, id: created.id, key: created.key });
    })
    // One key at a time, only the signed-in user's own live devices.
    .get("/:id{[0-9]+}/key", (c) => {
      const key = getDeviceKey(db, c.get("userId"), Number(c.req.param("id")));
      if (!key) return c.json({ error: "key not available" }, 404);
      return c.json({ key });
    })
    .post("/:id{[0-9]+}/revoke", (c) => {
      if (!revokeDevice(db, c.get("userId"), Number(c.req.param("id")))) {
        return c.json({ error: "device not found" }, 404);
      }
      return c.json({ ok: true });
    });
}
