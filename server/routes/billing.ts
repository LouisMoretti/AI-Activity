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
      const parsed = parseSubscription(await readJson(c));
      if (typeof parsed === "string") return c.json({ error: parsed }, 400);
      return c.json({ ok: true, id: insertSubscription(db, userId(), parsed) });
    });
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

/** A real calendar day as YYYY-MM-DD, or null. */
function isoDay(v: unknown): string | null {
  if (typeof v !== "string" || !ISO_DAY.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

/** Validated subscription fields, or an error message. */
function parseSubscription(body: Record<string, unknown>): Parameters<typeof insertSubscription>[2] | string {
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const tool = text(body.tool, 40);
  const plan_name = text(body.plan_name, 80);
  const amount = typeof body.amount === "string" && body.amount.trim() === "" ? NaN : Number(body.amount);
  if (!tool || !plan_name || !Number.isFinite(amount)) {
    return "tool and plan_name (non-empty strings) and a numeric amount are required";
  }
  if (amount < 0) return "amount must be >= 0";
  const currency = body.currency === undefined || body.currency === null || body.currency === ""
    ? "USD"
    : text(body.currency, 8).toUpperCase();
  if (!CURRENCIES.has(currency)) return "currency must be an ISO 4217 code, e.g. USD or EUR";
  const period_start = body.period_start ? isoDay(body.period_start) : null;
  const period_end = body.period_end ? isoDay(body.period_end) : null;
  if ((body.period_start && !period_start) || (body.period_end && !period_end)) {
    return "period_start and period_end must be YYYY-MM-DD dates";
  }
  if (period_start && period_end && period_start > period_end) {
    return "period_start must not be after period_end";
  }
  const note = text(body.note, 500) || null;
  return { tool, plan_name, amount, currency, period_start, period_end, note };
}
