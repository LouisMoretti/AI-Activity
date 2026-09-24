import { Hono } from "hono";
import type { BillingResponse } from "../../shared/types.ts";
import {
  estimatedCostAvailable, insertSubscription, listBillingRecords, listSubscriptions, usageTotals,
} from "../db/queries.ts";
import type { DB } from "../db/schema.ts";
import { readJson } from "../lib/http.ts";

export function billingRoutes(db: DB, userId: () => number) {
  return new Hono()
    .get("/", (c) => {
      const uid = userId();
      return c.json<BillingResponse>({
        subscriptions: listSubscriptions(db, uid),
        billing_records: listBillingRecords(db, uid),
        estimated_api_equivalent_usd: Number(usageTotals(db, uid, 0, null).estimated_usd || 0),
        estimated_available: estimatedCostAvailable(db, uid),
        disclaimer: "Paid amounts are manually entered invoices. The API-equivalent estimate is derived from measured tokens and is neither an invoice nor a saving.",
      });
    })
    .post("/subscription", async (c) => {
      const body = await readJson(c);
      if (!body.tool || !body.plan_name || !Number.isFinite(Number(body.amount))) {
        return c.json({ error: "tool, plan_name and numeric amount are required" }, 400);
      }
      const id = insertSubscription(db, userId(), {
        tool: String(body.tool),
        plan_name: String(body.plan_name),
        amount: Number(body.amount),
        currency: String(body.currency || "USD"),
        period_start: body.period_start ? String(body.period_start) : null,
        period_end: body.period_end ? String(body.period_end) : null,
        note: body.note ? String(body.note) : null,
      });
      return c.json({ ok: true, id });
    });
}
