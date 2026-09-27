import { test } from "node:test";
import assert from "node:assert/strict";
import { meterLevel } from "../web/src/lib/meter.ts";

test("meter levels change at the shared rounded thresholds", () => {
  assert.equal(meterLevel(0), "normal");
  assert.equal(meterLevel(69), "normal");
  assert.equal(meterLevel(69.4), "normal");
  assert.equal(meterLevel(69.5), "warning");
  assert.equal(meterLevel(70), "warning");
  assert.equal(meterLevel(89), "warning");
  assert.equal(meterLevel(89.4), "warning");
  assert.equal(meterLevel(89.5), "danger");
  assert.equal(meterLevel(90), "danger");
  assert.equal(meterLevel(100), "danger");
});

test("meter levels clamp out-of-range percentages", () => {
  assert.equal(meterLevel(-1), "normal");
  assert.equal(meterLevel(101), "danger");
});
