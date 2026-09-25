import { Hono } from "hono";
import type { IngestResult } from "../../shared/types.ts";
import { findDeviceByKey, insertQuotaSnapshot, insertUsageEvent } from "../db/queries.ts";
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

    const ev = normalize(body);
    const received = nowSec();
    // Empty snapshots skip the usage row so event counts stay honest;
    // their quota snapshots below are still recorded.
    const result = hasConsumption(ev)
      ? insertUsageEvent(db, {
        event_id: ev.event_id,
        device_id: device.id,
        user_id: device.user_id,
        tool: ev.tool,
        session_id: ev.session_id,
        prompt_id: ev.prompt_id,
        model: ev.model,
        input_tokens: ev.input_tokens,
        output_tokens: ev.output_tokens,
        cache_read_tokens: ev.cache_read_tokens,
        cache_write_tokens: ev.cache_write_tokens,
        context_window_size: ev.context_window_size,
        context_used_pct: ev.context_used_pct,
        occurred_at: ev.occurred_at,
        received_at: received,
      })
      : { inserted: false, deduped: false };

    // Quotas are snapshots: latest value wins, never summed. They are dated
    // by the event time (already capped at now), so a replayed offline spool
    // cannot overwrite a newer snapshot with its stale rate_limits.
    for (const q of ev.quotas) {
      insertQuotaSnapshot(db, {
        device_id: device.id,
        user_id: device.user_id,
        account_ref: ev.account_ref,
        tool: ev.tool,
        limit_type: q.limit_type,
        used_pct: q.used_pct,
        resets_at: q.resets_at,
        measured_at: ev.occurred_at,
      });
    }
    return c.json<IngestResult>({
      ok: true,
      deduped: !result.inserted,
      stored: result.inserted,
      event_id: ev.event_id,
    });
  })
    // Collectors have no viewer session: without this, a bare /api/ingest
    // would fall through to the session gate and look like a 401.
    .all("*", (c) => c.json({ error: "use POST /api/ingest/<tool>, e.g. /api/ingest/claude-code" }, 404));
}
