import assert from "node:assert/strict";
import { test } from "node:test";
import { relationLabel } from "./lexicon.ts";

test("a relation reads as how the word stands to its target", () => {
  assert.equal(relationLabel({ kind: "aspect-partner", lemma: "zrobić", aspect: "Perf" }), "perfective partner");
  assert.equal(relationLabel({ kind: "derived-from", lemma: "golić", how: "perfective" }), "perfective of");
  assert.equal(relationLabel({ kind: "derived-from", lemma: "pisać", how: "noun-from-verb" }), "noun from");
  assert.equal(relationLabel({ kind: "variant-of", lemma: "bzykać", tags: ["regional"] }), "regional form of");
  assert.equal(relationLabel({ kind: "variant-of", lemma: "x", tags: [] }), "variant of");
});
