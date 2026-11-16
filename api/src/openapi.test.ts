import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { appSpec } from "./spec.ts";

test("api/openapi.json is the routes' spec", async () => {
  const written: unknown = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));
  assert.deepEqual(written, await appSpec(), "api/openapi.json is stale: run just openapi");
});
