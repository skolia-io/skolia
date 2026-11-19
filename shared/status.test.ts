import assert from "node:assert/strict";
import { test } from "node:test";
import { CompatibleStatus, Status } from "./schemas.ts";
import { compatibleStatus } from "./status.ts";

const artifacts = { analyzer: "a", lexicon: "l", analysis: "doc/x/analysis/a.json.br", bundle: "doc/x/bundle/b.json.br" };
const updatedAt = "2026-11-04T00:00:00.000Z";

test("status requires the fields its state promises", () => {
  assert.equal(Status.safeParse({ state: "ready", updatedAt }).success, false);
  assert.equal(Status.safeParse({ state: "failed", updatedAt }).success, false);
  for (const state of ["queued", "failed", "ready"] as const) {
    assert.equal(Status.safeParse({ state, updatedAt, error: "failed", artifacts: { analysis: "partial" } }).success, false);
  }
  assert.deepEqual(Status.parse({ state: "queued", updatedAt, error: "irrelevant" }), { state: "queued", updatedAt });
});

test("the nested status round-trips every persisted variant", () => {
  const statuses = [
    { state: "queued", updatedAt },
    { state: "queued", updatedAt, artifacts },
    { state: "ready", updatedAt, artifacts },
    { state: "failed", updatedAt, error: "failed" },
    { state: "failed", updatedAt, error: "failed", artifacts },
  ] as const;
  for (const status of statuses) {
    const encoded = JSON.stringify(compatibleStatus(status));
    assert.deepEqual(JSON.parse(encoded), { ...status, updated: updatedAt });
    assert.deepEqual(CompatibleStatus.parse(JSON.parse(encoded)), status);
    const { updatedAt: updated, ...legacy } = status;
    assert.deepEqual(CompatibleStatus.parse({ ...legacy, updated }), status);
  }
});
