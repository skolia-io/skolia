import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptsEncoding } from "./app.ts";
import { STUCK_AFTER_MS, countWords, isOutdated, isStuck, nameOf, parseStatus, parseVersions } from "./controllers/documents.ts";

const NOW = "2026-11-04T00:00:00Z";
const ARTIFACTS = { analyzer: "a", lexicon: "l", analysis: "d/analysis/s2-a1.json.br", bundle: "d/bundle/b1-a1-l1.json.br" };

test("accept-encoding parsing", () => {
  assert.equal(acceptsEncoding("gzip, deflate, br, zstd", "br"), true);
  assert.equal(acceptsEncoding("br;q=0", "br"), false);
  assert.equal(acceptsEncoding("*", "br"), true);
  assert.equal(acceptsEncoding("gzip", "br"), false);
  assert.equal(acceptsEncoding(undefined, "br"), false);
});

test("stuck and outdated rules", () => {
  const at = new Date(NOW);
  const old = new Date(at.getTime() - STUCK_AFTER_MS - 1).toISOString();
  assert.equal(isStuck({ state: "queued", updated: NOW }, at), false);
  assert.equal(isStuck({ state: "queued", updated: old }, at), true);
  assert.equal(isStuck({ state: "ready", updated: old, artifacts: ARTIFACTS }, at), false);
  assert.equal(isStuck({ state: "analysing", updated: "garbage" }, at), true);
  assert.equal(nameOf("doc/x/analysis/s2-a1.json.br"), "s2-a1");
  assert.equal(nameOf(undefined), undefined);
  const latest = { analyzer: "a", lexicon: "l", analysis: "s2-a1", bundle: "b1-a1-l1" };
  const ready = { state: "ready", updated: NOW, artifacts: ARTIFACTS } as const;
  assert.equal(isOutdated(ready, latest), false);
  assert.equal(isOutdated(ready, { ...latest, analysis: "s3-a1" }), true);
  assert.equal(isOutdated(ready, null), false);
  assert.equal(isOutdated({ ...ready, state: "failed", error: "failed" }, { ...latest, analysis: "s3-a1" }), false);
});

test("versions parsing ignores malformed blobs", () => {
  const versions = { analyzer: "a", lexicon: "l", analysis: "s2-a1", bundle: "b1-a1-l1" };
  assert.deepEqual(parseVersions(JSON.stringify(versions)), versions);
  assert.equal(parseVersions('{"analyzer":"a","lexicon":"l"}'), null);
  assert.equal(parseVersions("nope"), null);
});

test("status parsing ignores malformed blobs", () => {
  assert.equal(parseStatus("not json"), null);
  assert.equal(parseStatus(JSON.stringify({ state: "done", updated: "x" })), null);
  assert.equal(parseStatus(JSON.stringify({ state: "ready", updated: "x", bundle: 3 })), null);
  assert.equal(parseStatus(JSON.stringify({ state: "ready", updated: "x" })), null);
  assert.equal(parseStatus(JSON.stringify({ state: "failed", updated: "x" })), null);
  assert.equal(parseStatus(JSON.stringify({ state: "queued", updated: "x", analysis: "partial" })), null);
  assert.equal(parseStatus(JSON.stringify({ state: "queued", updated: "x", artifacts: { analysis: "partial" } })), null);
  const ready = { state: "ready", updated: "x", artifacts: ARTIFACTS };
  assert.deepEqual(parseStatus(JSON.stringify({ ...ready, extra: 1 })), ready);
  assert.deepEqual(parseStatus(JSON.stringify({ state: "ready", updated: "x", ...ARTIFACTS })), ready);
  for (const state of ["queued", "analysing", "failed"] as const) {
    const status = { state, updated: "x", ...(state === "failed" ? { error: "failed" } : {}) };
    assert.deepEqual(parseStatus(JSON.stringify(status)), status);
    assert.deepEqual(parseStatus(JSON.stringify({ ...status, ...ARTIFACTS })), { ...status, artifacts: ARTIFACTS });
  }
});

test("words are counted as runs containing letters", () => {
  assert.equal(countWords("Idę do psa — 12 razy."), 4);
});
