import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CARD_PAGE,
  MAX_CLOZES,
  type CardGroup,
  type CardState,
  type CardKey,
  type Due,
  type LemmaId,
  type NewClozeInput,
  type Rating,
} from "@skolia/shared/api";
import type { Cursor } from "@skolia/shared/page";
import {
  ALICE,
  NOW,
  client,
  importSentences,
  importer,
  loadLexicon,
  local,
  raw,
  refusesBadPages,
  setup,
  useLocal,
  walk,
  type App,
} from "./testing/app.ts";
import { body, expectStatus } from "./testing/responses.ts";

useLocal();

const DAY_START = "2026-11-03T23:00:00.000Z";
/** A text no one imported. */
const DOC = "a".repeat(64);
const SENTENCE = "Szukam pracy od roku.";

/** pracy blanked out of SENTENCE, 40 characters into a text; offsets are in the text. */
const PRACY: NewClozeInput = {
  lemmaId: "pl:praca:NOUN",
  documentId: DOC,
  sentence: SENTENCE,
  sentenceStart: 40,
  blankStart: 47,
  blankEnd: 52,
  feats: { Case: "Gen", Number: "Sing" },
  why: "szukać governs the genitive for its object.",
};
const MAM: NewClozeInput = { ...PRACY, sentence: "Mam pracę.", sentenceStart: 90, blankStart: 94, blankEnd: 99 };
const DOM: NewClozeInput = {
  ...PRACY,
  lemmaId: "pl:dom:NOUN",
  sentence: "Idę do domu.",
  sentenceStart: 100,
  blankStart: 107,
  blankEnd: 111,
};
const OLA: NewClozeInput = { ...PRACY, lemmaId: "pl:Ola:NOUN", sentence: "Widzę Olę.", sentenceStart: 200, blankStart: 206, blankEnd: 209 };

async function signedIn(): Promise<Headers> {
  return local.signIn((await local.signUp(ALICE)).id);
}

function make(app: App, headers: Headers | undefined, json: NewClozeInput) {
  return client(app, headers).me.cards.$post({ json: { kind: "cloze", ...json } });
}

async function due(app: App, headers: Headers, group?: CardGroup): Promise<Due> {
  return (await body("due", client(app, headers).me.cards.due.$get({ query: { lang: "pl", dayStart: DAY_START, group } }))) as Due;
}

/** PRACY, from a text the user imported with it. */
async function pracy(app: App, headers: Headers): Promise<NewClozeInput> {
  return { ...PRACY, documentId: await importSentences(app, headers, [PRACY]) };
}

/** The text's cards, by id and where their blanks start. */
async function listed(app: App, headers: Headers, documentId: string) {
  const { items, next } = await body("cards", client(app, headers).me.cards.$get({ query: { documentId } }));
  return { items: items.map((c) => ({ cardId: c.id, start: c.cloze?.blankStart })), next };
}

/** Makes the word's recognition and production cards, or keeps those it has. */
async function learn(app: App, headers: Headers, lemmaId: LemmaId): Promise<void> {
  for (const kind of ["recognition", "production"] as const) {
    assert.ok((await client(app, headers).me.cards.$post({ json: { kind, lemmaId } })).ok, `${lemmaId} ${kind}`);
  }
}

/** The word's cards, newest first. */
async function wordCards(app: App, headers: Headers, lemmaId: LemmaId) {
  return (await body("word's cards", client(app, headers).me.cards.$get({ query: { lemmaId } }))).items;
}

/** Sets the state of the word's cards, its cloze cards too unless words is set. */
async function mark(app: App, headers: Headers, lemmaId: LemmaId, state: CardState, words = false): Promise<void> {
  for (const card of await wordCards(app, headers, lemmaId)) {
    if (words && card.kind === "cloze") continue;
    await expectStatus("mark", client(app, headers).me.cards[":cardId"].$patch({ param: { cardId: card.id }, json: { state } }), 204);
  }
}

function review(app: App, headers: Headers, cardId: string, rating: Rating) {
  return client(app, headers).me.reviews.$post({ json: { id: crypto.randomUUID(), cardId, rating, at: NOW } });
}

/** Makes the word's cards and reviews its recognition card, so its new cloze cards come up. */
async function start(app: App, headers: Headers, lemmaId: LemmaId): Promise<void> {
  await learn(app, headers, lemmaId);
  const recognition = (await due(app, headers, "words")).cards.find((c) => c.lemmaId === lemmaId && c.kind === "recognition");
  if (!recognition) throw new Error(`${lemmaId} has no new recognition card`);
  await body("review", review(app, headers, recognition.id, 3));
}

test("a cloze card keeps its sentence and blank, is due with its lemma's entry, and is made once per sentence and word", async () => {
  const app = setup();
  const headers = await signedIn();
  await loadLexicon("pl", "lex/1", [{ lemmaId: "pl:praca:NOUN", lemma: "praca", upos: "NOUN", gloss: "work, job" }]);
  const json = await pracy(app, headers);
  const { cardId } = await body("made", make(app, headers, json), 201);
  assert.deepEqual(await body("made again", make(app, headers, { ...json, why: null }), 200), { cardId });
  // The same word in the text, with its sentence split elsewhere, as a redone analysis might
  assert.deepEqual(await body("split elsewhere", make(app, headers, { ...json, sentence: "pracy od roku.", sentenceStart: 47 }), 200), {
    cardId,
  });
  await learn(app, headers, "pl:praca:NOUN");
  assert.deepEqual((await due(app, headers, "forms")).cards, []);
  await start(app, headers, "pl:praca:NOUN");
  const { cards } = await due(app, headers, "forms");
  assert.equal(cards.length, 1);
  const [card] = cards;
  assert.equal(card?.kind, "cloze");
  assert.equal(card.lemmaId, "pl:praca:NOUN");
  assert.equal(card.entry?.lemma, "praca");
  const { lemmaId: _, ...stored } = json;
  assert.deepEqual(card.cloze, stored);
  assert.deepEqual(await listed(app, headers, json.documentId), { items: [{ cardId, start: 47 }], next: null });
  assert.deepEqual(await listed(app, headers, "b".repeat(64)), { items: [], next: null });
  assert.equal((await review(app, headers, cardId, 3)).status, 200);
});

test("a lemma can have many cloze cards; known, they leave reviews, and learning brings them back", async () => {
  const app = setup();
  const headers = await signedIn();
  await learn(app, headers, "pl:praca:NOUN");
  const documentId = await importSentences(app, headers, [PRACY, MAM]);
  await body("first", make(app, headers, { ...PRACY, documentId }), 201);
  await body("second", make(app, headers, { ...MAM, documentId }), 201);
  const kinds = async () => (await due(app, headers)).cards.map((c) => c.kind).sort();
  assert.deepEqual(await kinds(), ["production", "recognition"]);
  await start(app, headers, "pl:praca:NOUN");
  assert.deepEqual(await kinds(), ["cloze", "cloze", "production"]);
  await mark(app, headers, "pl:praca:NOUN", "known");
  assert.deepEqual(await kinds(), []);
  await mark(app, headers, "pl:praca:NOUN", "learning");
  assert.deepEqual(await kinds(), ["cloze", "cloze", "production"]);
});

test("a cloze card makes no other card, and waits only for its word's cards being learnt to be started", async () => {
  const app = setup();
  const headers = await signedIn();
  const documentId = await importSentences(app, headers, [PRACY, DOM]);
  const alone = await body("no word cards", make(app, headers, { ...PRACY, documentId }), 201);
  assert.deepEqual(
    (await wordCards(app, headers, "pl:praca:NOUN")).map((c) => [c.id, c.kind]),
    [[alone.cardId, "cloze"]],
  );
  await learn(app, headers, "pl:dom:NOUN");
  const dom = await body("word cards", make(app, headers, { ...DOM, documentId }), 201);
  const kinds = async () => (await due(app, headers)).cards.map((c) => [c.lemmaId, c.kind]).sort();
  assert.deepEqual(await kinds(), [
    ["pl:dom:NOUN", "production"],
    ["pl:dom:NOUN", "recognition"],
    ["pl:praca:NOUN", "cloze"],
  ]);
  // Known, the word's cards no longer hold its cloze card back
  await mark(app, headers, "pl:dom:NOUN", "known", true);
  assert.deepEqual(await kinds(), [
    ["pl:dom:NOUN", "cloze"],
    ["pl:praca:NOUN", "cloze"],
  ]);
  assert.ok((await due(app, headers, "forms")).cards.some((c) => c.id === dom.cardId));
});

test("a new cloze card comes up once one of its word's cards has been reviewed, and not for another word's", async () => {
  const app = setup();
  const headers = await signedIn();
  await learn(app, headers, "pl:dom:NOUN");
  await learn(app, headers, "pl:praca:NOUN");
  const { cardId } = await body("made", make(app, headers, await pracy(app, headers)), 201);
  assert.deepEqual(await due(app, headers, "forms"), { cards: [], newLeft: { words: 20, forms: 20 }, featureSets: {} });
  await start(app, headers, "pl:dom:NOUN");
  assert.deepEqual((await due(app, headers, "forms")).cards, []);
  await start(app, headers, "pl:praca:NOUN");
  assert.deepEqual(
    (await due(app, headers, "forms")).cards.map((c) => [c.id, c.isNew]),
    [[cardId, true]],
  );
});

test("deleting a cloze card takes it and its reviews away, and another user's can't be", async () => {
  const app = setup();
  const headers = await signedIn();
  const json = await pracy(app, headers);
  const { cardId } = await body("made", make(app, headers, json), 201);
  assert.equal((await review(app, headers, cardId, 1)).status, 200);
  const remove = (h: Headers, id: string) => client(app, h).me.cards[":cardId"].$delete({ param: { cardId: id } });
  const bob = await local.signIn((await local.signUp({ name: "Bob", email: "bob@example.com" })).id);
  assert.equal((await remove(bob, cardId)).status, 404);
  assert.equal((await remove(headers, cardId)).status, 204);
  assert.equal((await remove(headers, cardId)).status, 404);
  assert.deepEqual(await listed(app, headers, json.documentId), { items: [], next: null });
  assert.equal((await review(app, headers, cardId, 3)).status, 404);
  // Made again, it's a new card
  const again = await body("made again", make(app, headers, json), 201);
  assert.notEqual(again.cardId, cardId);
});

test("cloze cards need a session, and a blank that's a word inside its sentence", async () => {
  const app = setup();
  assert.equal((await make(app, undefined, PRACY)).status, 401);
  assert.equal((await client(app).me.cards.$get({ query: { documentId: DOC } })).status, 401);
  const headers = await signedIn();
  const refused: NewClozeInput[] = [
    { ...PRACY, blankEnd: PRACY.sentenceStart + SENTENCE.length + 1 },
    { ...PRACY, blankStart: 39, blankEnd: 47 },
    { ...PRACY, blankStart: 52, blankEnd: 52 },
    { ...PRACY, blankStart: 46, blankEnd: 47 },
    { ...PRACY, sentence: "" },
    { ...PRACY, sentence: "x".repeat(2001) },
    { ...PRACY, why: "x".repeat(501) },
    { ...PRACY, documentId: "abc" },
    { ...PRACY, lemmaId: "zz:praca:NOUN" as LemmaId },
  ];
  for (const json of refused) assert.equal((await make(app, headers, json)).status, 400, JSON.stringify(json));
  assert.equal((await raw(app, "POST", "/api/me/cards", headers, { kind: "cloze", ...PRACY, feats: { Case: 1 } })).status, 400);
  assert.equal((await raw(app, "POST", "/api/me/cards", headers, { ...PRACY })).status, 400);
  assert.equal((await raw(app, "POST", "/api/me/cards", headers, { kind: "recognition", ...PRACY })).status, 400);
  assert.equal((await client(app, headers).me.cards.$get({ query: { documentId: "abc" } })).status, 400);
  assert.equal((await client(app, headers).me.cards[":cardId"].$delete({ param: { cardId: "nope" } })).status, 400);
  assert.equal((await due(app, headers)).cards.length, 0);
});

test("a text's cloze cards come a page at a time, by where their blanks start", async () => {
  const app = setup();
  const headers = await signedIn();
  const psa = [3, 1, 4, 0, 2].map(
    (n): NewClozeInput => ({ ...PRACY, sentence: "Widzę psa.", sentenceStart: n * 100, blankStart: n * 100 + 6, blankEnd: n * 100 + 9 }),
  );
  const documentId = await importSentences(app, headers, psa);
  const made = await Promise.all(
    psa.map(async (json) => ({
      cardId: (await body("made", make(app, headers, { ...json, documentId }), 201)).cardId,
      start: json.blankStart,
    })),
  );
  await body("another text's", make(app, headers, await pracy(app, headers)), 201);
  const cards = client(app, headers).me.cards;
  const all = await walk(2, (after?: Cursor<CardKey>) => body("cards", cards.$get({ query: { documentId, after, limit: "2" } })));
  assert.deepEqual(
    all.map((c) => ({ cardId: c.id, start: c.cloze?.blankStart })),
    [...made].sort((a, b) => a.start - b.start),
  );
  await refusesBadPages(CARD_PAGE.max, (query) => cards.$get({ query: { documentId, ...query } }));
});

test("a cloze card is made from a text the user sees", async () => {
  const app = setup();
  const headers = await signedIn();
  assert.deepEqual(await body("never imported", make(app, headers, PRACY), 404), { error: "no such document" });
  const hidden = await importSentences(app, importer, [DOM]);
  await expectStatus("another's private text", make(app, headers, { ...DOM, documentId: hidden }), 404);
  assert.deepEqual(await listed(app, headers, hidden), { items: [], next: null });
  const shared = await importSentences(app, importer, [OLA], { visibility: "public", licence: "cc0" });
  await body("another's public text", make(app, headers, { ...OLA, documentId: shared }), 201);
  await body("their own", make(app, headers, await pracy(app, headers)), 201);
});

test("a user has at most MAX_CLOZES cloze cards", async () => {
  const app = setup();
  const { id: user } = await local.signUp(ALICE);
  const headers = await local.signIn(user);
  const documentId = await importSentences(app, headers, [PRACY, MAM, DOM]);
  const { cardId } = await body("first", make(app, headers, { ...PRACY, documentId }), 201);
  const storage = await local.server.getWorker().getDurableObjectStorage("User", { name: user });
  const more = "WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)";
  await storage.exec(
    `${more} INSERT INTO card (id, lemma_id, kind, created_at, active, fsrs) SELECT 'more' || i, lemma_id, kind, created_at, active, fsrs FROM card, n WHERE kind = 'cloze'`,
    MAX_CLOZES - 1,
  );
  await storage.exec(
    `${more} INSERT INTO cloze (card_id, document_id, sentence, sentence_start, blank_start, blank_end, feats)
      SELECT 'more' || i, printf('%064x', i), sentence, sentence_start, blank_start, blank_end, feats FROM cloze, n`,
    MAX_CLOZES - 1,
  );
  const full = await expectStatus("full", make(app, headers, { ...MAM, documentId }), 409);
  assert.deepEqual(await full.json(), { error: `a user has at most ${MAX_CLOZES} cloze cards` });
  await expectStatus("full, for another word", make(app, headers, { ...DOM, documentId }), 409);
  assert.deepEqual(await wordCards(app, headers, "pl:dom:NOUN"), []);
  assert.deepEqual(await body("one it has", make(app, headers, { ...PRACY, documentId }), 200), { cardId });
  await expectStatus("deletes one", client(app, headers).me.cards[":cardId"].$delete({ param: { cardId } }), 204);
  await body("room again", make(app, headers, { ...MAM, documentId }), 201);
});
