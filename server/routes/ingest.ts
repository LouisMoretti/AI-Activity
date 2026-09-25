import { Hono } from "hono";
import type { IngestBatchResult, IngestResult } from "../../shared/types.ts";
import {
  dropSnapshotRows, findDeviceByKey, insertQuotaSnapshot, setSessionContext, upsertUsageEvent, type UpsertResult,
} from "../db/queries.ts";
import { nowSec, type DB } from "../db/schema.ts";
import { readJson } from "../lib/http.ts";
import { hasConsumption, normalizerFor } from "../lib/ingest.ts";
import { bearerKey } from "../lib/viewer-auth.ts";

/**
 * Device ingestion: POST /api/ingest/<tool slug>, authenticated by device
 * key, NOT by viewer session. The slug picks the payload normalizer; there
 * is no default tool, so a bare /api/ingest is a 404.
 */
export function ingestRoutes(db: DB) {
  return new Hono().post("/:tool", async (c) => {
    const tool = c.req.param("tool");
    const normalize = normalizerFor(tool);
    if (!normalize) return c.json({ error: `unknown tool "${tool}"` }, 404);

    const key = bearerKey(c);
    if (!key) {
      return c.json({ error: "missing Authorization: Bearer <device key> header" }, 401);
    }
    const device = findDeviceByKey(db, key);
    if (!device) return c.json({ error: "unknown or revoked device key" }, 401);

    const body = await readJson(c);
    // The URL says which tool this is; a payload claiming another one is a
    // misconfigured collector, not something to guess about.
    if (body.tool !== undefined && body.tool !== tool) {
      return c.json({ error: `payload tool "${String(body.tool)}" does not match /api/ingest/${tool}` }, 400);
    }

    const batch = normalize(body);
    const received = nowSec();
    const counts = { stored: 0, updated: 0, deduped: 0 };
    let single: UpsertResult | null = null;

    db.transaction(() => {
      const sessions = new Set<string>();
      for (const m of batch.messages) {
        if (m.session_id) sessions.add(m.session_id);
        // Empty messages skip the usage row so event counts stay honest.
        if (!hasConsumption(m)) continue;
        single = upsertUsageEvent(db, {
          ...m, device_id: device.id, user_id: device.user_id, tool: batch.tool, received_at: received,
        });
        counts[single] += 1;
      }
      for (const s of sessions) dropSnapshotRows(db, device.user_id, s);
      if (batch.context) {
        const { session_id, used_pct, window_size } = batch.context;
        setSessionContext(db, device.user_id, session_id, used_pct, window_size);
      }
      // Quotas are snapshots: latest value wins, never summed. They are dated
      // by the observation time (already capped at now), so a replayed
      // payload cannot overwrite a newer snapshot with stale rate_limits.
      for (const q of batch.quotas) {
        insertQuotaSnapshot(db, {
          device_id: device.id,
          user_id: device.user_id,
          account_ref: batch.account_ref,
          tool: batch.tool,
          limit_type: q.limit_type,
          used_pct: q.used_pct,
          resets_at: q.resets_at,
          measured_at: batch.measured_at,
        });
      }
    })();

    if (!batch.single) return c.json<IngestBatchResult>({ ok: true, messages: batch.messages.length, ...counts });
    const result = single as UpsertResult | null;
    return c.json<IngestResult>({
      ok: true,
      stored: result === "stored",
      updated: result === "updated",
      deduped: result === "deduped",
      event_id: batch.messages[0]?.event_id ?? null,
    });
  })
    // Collectors have no viewer session: without this, a bare /api/ingest
    // would fall through to the session gate and look like a 401.
    .all("*", (c) => c.json({ error: "use POST /api/ingest/<tool>, e.g. /api/ingest/claude-code" }, 404));
}
