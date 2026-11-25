import assert from "node:assert/strict";
import { test } from "node:test";
import type { Card } from "@skolia/shared/api";
import * as schemas from "@skolia/shared/schemas";
import { wordState } from "./word-state.ts";

const AT = schemas.Timestamp.parse("2026-11-07T00:00:00.000Z");

const card: Card = {
  id: schemas.CardId.parse("00000000-0000-4000-8000-000000000001"),
  lemmaIds: [schemas.LemmaId.parse("pl:pies:NOUN")],
  kind: "recognition",
  data: {},
  createdAt: AT,
  state: "known",
  scheduleStatus: "new",
  dueAt: AT,
  scheduledDays: 0,
  lastReviewedAt: null,
};

test("a word the user hasn't, or is learning with no cards, is new", () => {
  assert.equal(wordState(undefined), "new");
  assert.equal(wordState({ state: "learning", cards: [] }), "new");
});

test("a known word stays known once its cards are deleted", () => {
  assert.equal(wordState({ state: "known", cards: [card] }), "known");
  assert.equal(wordState({ state: "known", cards: [] }), "known");
});

test("a word being learnt with cards is learning", () => {
  assert.equal(wordState({ state: "learning", cards: [{ ...card, state: "learning" }] }), "learning");
});
