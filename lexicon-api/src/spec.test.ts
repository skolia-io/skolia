import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { lexiconSpec } from "./spec.ts";

test("lexicon-api/openapi.json is the routes' spec", async () => {
  const written: unknown = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));
  assert.deepEqual(written, await lexiconSpec(), "lexicon-api/openapi.json is stale: run just openapi");
});
