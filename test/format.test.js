import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtMoneyTotals } from "../web/src/lib/format.ts";

test("money totals are summed per currency, never across currencies", () => {
  assert.equal(
    fmtMoneyTotals([
      { amount: 20, currency: "USD" },
      { amount: 18, currency: "EUR" },
      { amount: 5.5, currency: "USD" },
    ]),
    "USD 25.5 · EUR 18",
  );
  assert.equal(fmtMoneyTotals([{ amount: 90, currency: "EUR" }]), "EUR 90");
});

test("money totals: empty input and float sums", () => {
  assert.equal(fmtMoneyTotals([]), "");
  assert.equal(fmtMoneyTotals([{ amount: 0.1, currency: "USD" }, { amount: 0.2, currency: "USD" }]), "USD 0.3");
});
