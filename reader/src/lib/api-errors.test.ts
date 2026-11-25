import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "@skolia/shared/schemas";
import { describeApiError } from "./api-errors.ts";

test("formats structured errors without server prose", () => {
  const { error } = ApiError.parse({
    error: { code: "rate-limited", action: "import", limit: 2, windowSeconds: 60, retryAfterSeconds: 45 },
  });
  assert.equal(describeApiError(error), "Too many imports. Try again in 45 seconds.");
  assert.equal(describeApiError({ code: "limit-exceeded", resource: "cards", limit: 20 }), "The limit is 20 cards per user.");
  assert.equal(ApiError.safeParse({ error: { code: "limit-exceeded", resource: "cards" } }).success, false);
});
