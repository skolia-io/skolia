import assert from "node:assert/strict";
import { test } from "node:test";
import { IMPORT_RATE, importRate } from "./rate-limits.ts";

test("the import limit is the vars', or the default for one that's unset", () => {
  assert.deepEqual(importRate({ IMPORT_RATE_LIMIT: "5", IMPORT_RATE_WINDOW_SECONDS: "600" }), { limit: 5, windowSeconds: 600 });
  assert.deepEqual(importRate({ IMPORT_RATE_LIMIT: 7 }), { limit: 7, windowSeconds: IMPORT_RATE.windowSeconds });
  assert.deepEqual(importRate({ IMPORT_RATE_WINDOW_SECONDS: "" }), IMPORT_RATE);
  assert.deepEqual(importRate({}), IMPORT_RATE);
});

test("an invalid import limit or window is its default, and leaves the other as it is", () => {
  for (const value of ["0", "-1", "2.5", "many", "10001"]) {
    const rate = importRate({ IMPORT_RATE_LIMIT: value, IMPORT_RATE_WINDOW_SECONDS: "600" });
    assert.deepEqual(rate, { limit: IMPORT_RATE.limit, windowSeconds: 600 }, value);
  }
  for (const value of ["0", "1.5", "an hour", String(7 * 24 * 60 * 60 + 1)]) {
    const rate = importRate({ IMPORT_RATE_LIMIT: "5", IMPORT_RATE_WINDOW_SECONDS: value });
    assert.deepEqual(rate, { limit: 5, windowSeconds: IMPORT_RATE.windowSeconds }, value);
  }
});
