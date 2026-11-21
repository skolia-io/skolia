import assert from "node:assert/strict";
import { test } from "node:test";
import { langOf, parseLemmaId } from "./api.ts";
import * as schemas from "./schemas.ts";

test("a lemma id's lemma is everything between its language and its part of speech", () => {
  assert.deepEqual(parseLemmaId(schemas.LemmaId.parse("pl:pies:NOUN")), { lang: "pl", lemma: "pies", upos: "NOUN" });
  assert.deepEqual(parseLemmaId(schemas.LemmaId.parse("pl:i/lub:CCONJ")), { lang: "pl", lemma: "i/lub", upos: "CCONJ" });
  assert.deepEqual(parseLemmaId(schemas.LemmaId.parse("en:a:b:X")), { lang: "en", lemma: "a:b", upos: "X" });
  assert.equal(langOf(schemas.LemmaId.parse("fr:aller:VERB")), "fr");
});
