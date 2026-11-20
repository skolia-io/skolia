import assert from "node:assert/strict";
import { test } from "node:test";
import { aspectOf, lenders, sensesOf } from "./lexicon.ts";
import type { Feats, Relation, Sense } from "./schema.gen.ts";

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

test("a verb's aspect is the one all its forms share, and none when they differ or lack one", () => {
  const sets: Record<number, Feats> = {
    0: { VerbForm: "Inf", Aspect: "Perf" },
    1: { VerbForm: "Fin", Aspect: "Perf", Tense: "Fut" },
    2: { VerbForm: "Fin", Aspect: "Imp", Tense: "Pres" },
    3: { Case: "Nom" },
  };
  const featsOf = (id: number) => sets[id];
  const with_ = (...ids: number[]) => ({ paradigms: [{ homonym: "", forms: ids.map((id): [string, number[]] => [`f${id}`, [id]]) }] });
  assert.equal(aspectOf(with_(0, 1), featsOf), "Perf");
  assert.equal(aspectOf(with_(0, 2), featsOf), undefined);
  assert.equal(aspectOf(with_(3), featsOf), undefined);
  assert.equal(aspectOf({ paradigms: [] }, featsOf), undefined);
});
