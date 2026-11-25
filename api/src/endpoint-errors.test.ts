import assert from "node:assert/strict";
import { test } from "node:test";
import { importDocumentErrors, reviewErrors } from "./endpoint-errors.ts";

test("an endpoint error accepts only its variants for that status", () => {
  const badImport = importDocumentErrors[400].schema;
  assert.equal(badImport.safeParse({ error: { code: "unknown-tag", tag: "level:A9" } }).success, true);
  assert.equal(badImport.safeParse({ error: { code: "invalid-request", path: ["title"] } }).success, true);
  assert.equal(badImport.safeParse({ error: { code: "invalid-json" } }).success, true);
  assert.equal(badImport.safeParse({ error: { code: "unknown-tag" } }).success, false);
  assert.equal(badImport.safeParse({ error: { code: "future-review" } }).success, false);
  assert.equal(reviewErrors[409].schema.safeParse({ error: { code: "review-too-old" } }).success, true);
  assert.equal(reviewErrors[409].schema.safeParse({ error: { code: "future-review" } }).success, false);
});

test("an endpoint can narrow a shared limit error to its resource", () => {
  const tooLarge = importDocumentErrors[413].schema;
  assert.equal(tooLarge.safeParse({ error: { code: "limit-exceeded", resource: "text-characters", limit: 5 } }).success, true);
  assert.equal(tooLarge.safeParse({ error: { code: "limit-exceeded", resource: "annotations", limit: 5 } }).success, false);
});
