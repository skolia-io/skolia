import assert from "node:assert/strict";
import { test } from "node:test";
import { lenders, sensesOf } from "./lexicon.ts";
import type { Relation, Sense } from "./schema.gen.ts";

const GOLIĆ: { senses: Sense[]; relations: Relation[] } = {
  senses: [
    { gloss: "to shave", tags: ["imperfective"], examples: [{ text: "Golę się." }] },
    { gloss: "to down, to soak (to drink)", tags: ["colloquial", "imperfective"] },
  ],
  relations: [],
};

const find = (id: string) => (id === "pl:golić:VERB" ? GOLIĆ : undefined);

test("a word with no senses takes the ones its relations name in their targets, without aspect tags", () => {
  const zgolić = {
    senses: [],
    relations: [
      { type: "derived-from", lemma: "golić", lemma_id: "pl:golić:VERB", sense_indexes: [1] },
      { type: "derived-from", lemma: "golnąć" },
    ] satisfies Relation[],
  };
  assert.deepEqual(sensesOf(zgolić, find), [{ gloss: "to down, to soak (to drink)", tags: ["colloquial"] }]);
  assert.deepEqual(lenders(zgolić, find), [GOLIĆ]);
});

test("a relation without sense indexes lends every sense, and a word with senses keeps its own", () => {
  const whole: Relation[] = [{ type: "aspect-partner", lemma: "golić", lemma_id: "pl:golić:VERB" }];
  assert.deepEqual(
    sensesOf({ senses: [], relations: whole }, find).map((s) => s.gloss),
    ["to shave", "to down, to soak (to drink)"],
  );
  const own = { senses: [{ gloss: "to shave off", tags: [] }], relations: whole };
  assert.deepEqual(sensesOf(own, find), own.senses);
  assert.deepEqual(lenders(own, find), []);
});
