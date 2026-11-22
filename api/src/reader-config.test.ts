import assert from "node:assert/strict";
import { test } from "node:test";
import { LEXICON_CONCURRENCY } from "@skolia/shared/api";
import { readerConfig } from "./reader-config.ts";

const DEFAULT = { lexiconConcurrency: LEXICON_CONCURRENCY.default };

test("the reader's lexicon concurrency is the var's, or the default when it's unset", () => {
  assert.deepEqual(readerConfig({ READER_LEXICON_CONCURRENCY: "12" }), { lexiconConcurrency: 12 });
  assert.deepEqual(readerConfig({ READER_LEXICON_CONCURRENCY: 3 }), { lexiconConcurrency: 3 });
  assert.deepEqual(readerConfig({}), DEFAULT);
  assert.deepEqual(readerConfig({ READER_LEXICON_CONCURRENCY: "" }), DEFAULT);
});

test("an invalid lexicon concurrency is the default", () => {
  for (const value of ["0", "-1", "2.5", "many", String(LEXICON_CONCURRENCY.max + 1)]) {
    assert.deepEqual(readerConfig({ READER_LEXICON_CONCURRENCY: value }), DEFAULT, value);
  }
});
