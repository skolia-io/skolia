import assert from "node:assert/strict";
import { test } from "node:test";
import { Status } from "./schemas.ts";

const artifacts = { analyzer: "a", lexicon: "l", analysis: "doc/x/analysis/a.json.br", bundle: "doc/x/bundle/b.json.br" };
const updated = "2026-11-04T00:00:00.000Z";

test("status requires the fields its state promises", () => {
  assert.equal(Status.safeParse({ state: "ready", updated }).success, false);
  assert.equal(Status.safeParse({ state: "failed", updated }).success, false);
  for (const state of ["queued", "failed", "ready"] as const) {
    assert.equal(Status.safeParse({ state, updated, error: "failed", artifacts: { analysis: "partial" } }).success, false);
  }
  assert.deepEqual(Status.parse({ state: "queued", updated, error: "irrelevant" }), { state: "queued", updated });
});

test("the nested status round-trips every persisted variant", () => {
  const statuses = [
    { state: "queued", updated },
    { state: "queued", updated, artifacts },
    { state: "ready", updated, artifacts },
    { state: "failed", updated, error: "failed" },
    { state: "failed", updated, error: "failed", artifacts },
  ] as const;
  for (const status of statuses) assert.deepEqual(Status.parse(JSON.parse(JSON.stringify(status))), status);
});
