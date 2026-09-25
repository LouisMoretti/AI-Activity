import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { tokenBuckets } from "../server/lib/rate-limit.ts";

describe("token buckets", () => {
  test("a full bucket allows `capacity` takes, then refills at perSec", () => {
    let t = 0;
    const b = tokenBuckets({ capacity: 3, perSec: 2 }, () => t);
    for (let i = 0; i < 3; i++) {
      assert.equal(b.wait("a"), 0);
      b.take("a");
    }
    assert.equal(b.wait("a"), 1); // ceil(1 token / 2 per s)
    t += 500;
    assert.equal(b.wait("a"), 0);
    // Keys are independent.
    assert.equal(b.wait("b"), 0);
  });

  test("taking more than is left is a debt that delays the next request", () => {
    let t = 0;
    const b = tokenBuckets({ capacity: 10, perSec: 1 }, () => t);
    b.take("dev", 30); // a batch wrote more rows than were left
    assert.equal(b.wait("dev"), 21);
    t += 20_000;
    assert.equal(b.wait("dev"), 1);
    t += 1000;
    assert.equal(b.wait("dev"), 0);
  });

  test("never refills past capacity", () => {
    let t = 0;
    const b = tokenBuckets({ capacity: 2, perSec: 1 }, () => t);
    t += 3_600_000;
    b.take("a", 2);
    assert.equal(b.wait("a"), 1);
  });
});
