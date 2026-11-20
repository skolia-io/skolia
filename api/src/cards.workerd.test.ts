import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CARD_PAGE,
  MATURE_DAYS,
  MAX_CARDS,
  MAX_NEW_PER_DAY,
  type Card,
  type CardCounts,
  type CardGroup,
  type CardKey,
  type CardState,
  type DocumentId,
  type Due,
  type Lang,
  type LemmaId,
  type NewClozeInput,
  type Rating,
  type Reviewed,
  type ReviewRequestInput,
  type Settings,
} from "@skolia/shared/api";
import { allPages, type Cursor } from "@skolia/shared/page";
import {
  ALICE,
  NOW,
  client,
  importSentences,
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

async function signedIn(): Promise<Headers> {
  return local.signIn((await local.signUp(ALICE)).id);
}

async function due(
  app: App,
  headers: Headers,
  lang: Lang,
  { dayStart = DAY_START, group }: { dayStart?: string; group?: CardGroup | undefined } = {},
): Promise<Due> {
  // Hono's JSON type makes the entries' optional fields `| undefined`; it's the same JSON
  return (await body("due", client(app, headers).me.cards.due.$get({ query: { lang, dayStart, group } }))) as Due;
}

function counts(app: App, headers: Headers): Promise<CardCounts[]> {
  return body("counts", client(app, headers).me.cards.counts.$get({ query: { dayStart: DAY_START } }));
}

/** Counts for a language with cards and nothing to review today. */
function none(lang: Lang): CardCounts {
  return { lang, words: { due: 0, new: 0 }, forms: { due: 0, new: 0 } };
}

/** A sentence n hundred characters into a text. */
function sentenceAt(n: number) {
  return { sentence: "Widzę psa.", sentenceStart: n * 100 };
}

/** A cloze card's data for psa in the sentence n hundred characters into the text. */
function clozeAt(documentId: DocumentId, n: number): NewClozeInput {
  return { ...sentenceAt(n), documentId, blankStart: n * 100 + 6, blankEnd: n * 100 + 9, feats: { Case: "Acc" }, why: null };
}

function postCloze(app: App, headers: Headers, lemmaId: LemmaId, data: NewClozeInput) {
  return client(app, headers).me.cards.$post({ json: { kind: "cloze", lemmaId, data } });
}

/** A cloze card for the lemma, n hundred characters into a text the user imports. */
async function makeCloze(app: App, headers: Headers, lemmaId: LemmaId, n: number) {
  const documentId = await importSentences(app, headers, [sentenceAt(n)]);
  return body("cloze", postCloze(app, headers, lemmaId, clozeAt(documentId, n)), 201);
}

function makeCard(app: App, headers: Headers | undefined, lemmaId: LemmaId, kind: "recognition" | "production") {
  return client(app, headers).me.cards.$post({ json: { kind, lemmaId } });
}

/** Makes the word's recognition and production cards, as the reader's + does. */
async function learn(app: App, headers: Headers, lemmaId: LemmaId): Promise<void> {
  for (const kind of ["recognition", "production"] as const) await body(`${lemmaId} ${kind}`, makeCard(app, headers, lemmaId, kind), 201);
}

/** Every card of the language, a page of limit at a time. */
function listCards(app: App, headers: Headers, lang: Lang, limit = CARD_PAGE.max) {
  return walk(limit, (after?: Cursor<CardKey>) =>
    body("cards", client(app, headers).me.cards.$get({ query: { lang, after, limit: String(limit) } })),
  );
}

/** Every card of the word, newest first. */
function wordCards(app: App, headers: Headers, lemmaId: LemmaId): Promise<readonly Card[]> {
  return allPages((after?: Cursor<CardKey>) => body("word's cards", client(app, headers).me.cards.$get({ query: { lemmaId, after } })));
}

function setState(app: App, headers: Headers | undefined, cardId: string, state: CardState) {
  return client(app, headers).me.cards[":cardId"].$patch({ param: { cardId }, json: { state } });
}

/** Marks each of the word's cards, as Review's Known does. */
async function markWord(app: App, headers: Headers, lemmaId: LemmaId, state: CardState): Promise<void> {
  for (const card of await wordCards(app, headers, lemmaId)) assert.equal((await setState(app, headers, card.id, state)).status, 204);
}

function deleteCard(app: App, headers: Headers | undefined, cardId: string) {
  return client(app, headers).me.cards[":cardId"].$delete({ param: { cardId } });
}

function review(app: App, headers: Headers | undefined, json: ReviewRequestInput) {
  return client(app, headers).me.reviews.$post({ json });
}

const DEFAULT_SETTINGS: Settings = { newLemmasPerDay: 20, newFormsPerDay: 20, formsWithWords: true };

function saveSettings(app: App, headers: Headers, settings: Partial<Settings>) {
  return client(app, headers).me.settings.$put({ json: { ...DEFAULT_SETTINGS, ...settings } });
}

function lookUp(app: App, ids: LemmaId[]) {
  return client(app).lexicon.entries.$post({ json: { ids } });
}

function answer(cardId: string, rating: Rating, at = NOW): ReviewRequestInput {
  return { id: crypto.randomUUID(), cardId, rating, at };
}

test("a word's recognition and production cards are new and due now, with its lexicon entry, and one of each is made", async () => {
  const app = setup();
  const headers = await signedIn();
  await loadLexicon(
    "pl",
    "lex/1",
    [{ lemmaId: "pl:pies:NOUN", lemma: "pies", upos: "NOUN", gloss: "dog", paradigms: [{ homonym: "", forms: [["psa", [1]]] }] }],
    [{ Case: "Nom" }, { Case: "Gen" }],
  );
  await learn(app, headers, "pl:pies:NOUN");
  const { cardId } = await body("again", makeCard(app, headers, "pl:pies:NOUN", "recognition"), 200);
  await learn(app, headers, "pl:kot:NOUN");
  const { cards, newLeft, featureSets } = await due(app, headers, "pl");
  assert.deepEqual(newLeft, { words: 20, forms: 20 });
  assert.deepEqual(featureSets, { "1": { Case: "Gen" } });
  assert.deepEqual(
    cards.map((c) => [c.lemmaId, c.kind, c.isNew, c.entry?.senses[0]?.gloss ?? null]),
    [
      ["pl:kot:NOUN", "recognition", true, null],
      ["pl:kot:NOUN", "production", true, null],
      ["pl:pies:NOUN", "recognition", true, "dog"],
      ["pl:pies:NOUN", "production", true, "dog"],
    ],
  );
  assert.equal(cards[2]?.id, cardId);
  assert.deepEqual((await wordCards(app, headers, "pl:pies:NOUN")).map((c) => [c.kind, c.state]).sort(), [
    ["production", "learning"],
    ["recognition", "learning"],
  ]);
});

test("counts omit languages without cards but include cards scheduled for later", async () => {
  const app = setup();
  const headers = await signedIn();
  assert.deepEqual(await counts(app, headers), []);
  await learn(app, headers, "pl:pies:NOUN");
  for (const card of (await due(app, headers, "pl")).cards) {
    await body("review", review(app, headers, answer(card.id, 4)));
  }
  assert.deepEqual(await counts(app, headers), [none("pl")]);
});

test("a known card isn't reviewed, and learning puts it back where it was in its schedule", async () => {
  const app = setup();
  const headers = await signedIn();
  await learn(app, headers, "pl:pies:NOUN");
  await learn(app, headers, "pl:kot:NOUN");
  await markWord(app, headers, "pl:kot:NOUN", "known");
  assert.equal((await due(app, headers, "pl")).cards.length, 2);
  const [recognition] = (await due(app, headers, "pl")).cards;
  assert.ok(recognition);
  await body("review", review(app, headers, answer(recognition.id, 1)));
  const later = setup({ at: "2026-11-04T00:30:00Z" });
  const pies = async () => (await due(later, headers, "pl")).cards.map((c) => [c.id, c.kind, c.isNew]);
  const before = await pies();
  assert.equal(before.length, 2);
  await markWord(app, headers, "pl:pies:NOUN", "known");
  assert.deepEqual(await pies(), []);
  assert.deepEqual(await counts(later, headers), [none("pl")]);
  assert.deepEqual(
    (await wordCards(app, headers, "pl:pies:NOUN")).map((c) => c.state),
    ["known", "known"],
  );
  await markWord(app, headers, "pl:pies:NOUN", "learning");
  assert.deepEqual(await pies(), before);
});

test("a review schedules the card, a retried review is counted once, and the day's new words are limited by the setting", async () => {
  const app = setup();
  const headers = await signedIn();
  assert.deepEqual(await body("settings", client(app, headers).me.settings.$get()), DEFAULT_SETTINGS);
  assert.equal((await saveSettings(app, headers, { newLemmasPerDay: 1 })).status, 204);
  await learn(app, headers, "pl:pies:NOUN");
  await learn(app, headers, "pl:kot:NOUN");
  const before = (await due(app, headers, "pl")).cards;
  assert.deepEqual(
    before.map((c) => [c.lemmaId, c.kind]),
    [
      ["pl:kot:NOUN", "recognition"],
      ["pl:kot:NOUN", "production"],
    ],
  );
  const [card, other] = before;
  assert.ok(card && other);
  const good = answer(card.id, 3);
  const reviewed: Reviewed = await body("review", review(app, headers, good));
  assert.ok(reviewed.dueAt > NOW);
  assert.deepEqual(await body("review retried", review(app, headers, good)), reviewed);
  // The word's other card comes with it, though the day's allowance is used up
  const after = await due(app, headers, "pl");
  assert.deepEqual(
    after.cards.map((c) => c.id),
    [other.id],
  );
  assert.deepEqual(after.newLeft, { words: 0, forms: 20 });
  // The next day's allowance
  assert.deepEqual(
    (await due(app, headers, "pl", { dayStart: "2026-11-04T00:00:00.001Z" })).cards.map((c) => [c.lemmaId, c.kind]),
    [
      ["pl:kot:NOUN", "production"],
      ["pl:pies:NOUN", "recognition"],
      ["pl:pies:NOUN", "production"],
    ],
  );
  // A day start without milliseconds is the same time: compared as strings, "00Z" sorts after "00.000Z"
  assert.equal((await due(app, headers, "pl", { dayStart: "2026-11-04T00:00:00Z" })).newLeft.words, 0);
});

test("a word uses one place in the day's allowance, however many of its cards are reviewed, and only on its first day", async () => {
  const app = setup();
  const headers = await signedIn();
  await saveSettings(app, headers, { newLemmasPerDay: 2 });
  for (const lemmaId of ["pl:a:NOUN", "pl:b:NOUN", "pl:c:NOUN", "pl:d:NOUN"] as const) await learn(app, headers, lemmaId);
  const first = await due(app, headers, "pl");
  assert.deepEqual(
    first.cards.map((c) => c.lemmaId),
    ["pl:a:NOUN", "pl:a:NOUN", "pl:b:NOUN", "pl:b:NOUN"],
  );
  // Counts give new words in lemmas, as the allowance does, not their four cards
  assert.equal(first.newLeft.words, 2);
  assert.deepEqual((await counts(app, headers))[0]?.words, { due: 0, new: 2 });
  for (const card of first.cards.filter((c) => c.lemmaId === "pl:a:NOUN")) await body("review", review(app, headers, answer(card.id, 3)));
  const left = await due(app, headers, "pl");
  assert.equal(left.newLeft.words, 1);
  assert.deepEqual(
    left.cards.map((c) => c.lemmaId),
    ["pl:b:NOUN", "pl:b:NOUN"],
  );
  assert.deepEqual((await counts(app, headers))[0]?.words, { due: 0, new: 1 });
  const [bRecognition, bProduction] = left.cards;
  assert.ok(bRecognition && bProduction);
  await body("review", review(app, headers, answer(bRecognition.id, 3)));
  assert.deepEqual(
    (await due(app, headers, "pl")).cards.map((c) => c.id),
    [bProduction.id],
  );
  // The next day: b's other card is reviewed, but b was started the day before
  const at = "2026-11-05T00:00:00.000Z";
  const nextDay = setup({ at });
  const dayStart = "2026-11-04T23:00:00.000Z";
  await body("review", review(nextDay, headers, answer(bProduction.id, 3, at)));
  const second = await due(nextDay, headers, "pl", { dayStart });
  assert.equal(second.newLeft.words, 2);
  assert.deepEqual(
    second.cards.filter((c) => c.isNew).map((c) => c.lemmaId),
    ["pl:c:NOUN", "pl:c:NOUN", "pl:d:NOUN", "pl:d:NOUN"],
  );
});

test("cloze cards have their own daily allowance, and a new one waits for its word's cards to be started", async () => {
  const app = setup();
  const headers = await signedIn();
  await saveSettings(app, headers, { newLemmasPerDay: 1, newFormsPerDay: 1 });
  await learn(app, headers, "pl:pies:NOUN");
  const clozes = [await makeCloze(app, headers, "pl:pies:NOUN", 0), await makeCloze(app, headers, "pl:pies:NOUN", 1)];
  const kinds = async (group?: CardGroup) => (await due(app, headers, "pl", { group })).cards.map((c) => c.kind);
  assert.deepEqual(await kinds(), ["recognition", "production"]);
  assert.deepEqual(await kinds("forms"), []);
  assert.deepEqual(await counts(app, headers), [{ ...none("pl"), words: { due: 0, new: 1 } }]);

  const [recognition] = (await due(app, headers, "pl", { group: "words" })).cards;
  assert.equal(recognition?.kind, "recognition");
  await body("review", review(app, headers, answer(recognition.id, 3)));
  // Started, its word gets a cloze card a day; the words' allowance is used up, but not by it
  const both = await due(app, headers, "pl");
  assert.deepEqual(
    both.cards.map((c) => c.kind),
    ["production", "cloze"],
  );
  assert.deepEqual(both.newLeft, { words: 0, forms: 1 });
  assert.deepEqual(await kinds("words"), ["production"]);
  const [cloze] = (await due(app, headers, "pl", { group: "forms" })).cards;
  assert.ok(cloze);
  // Made at the same time, either can come first
  assert.ok(clozes.some((c) => c.cardId === cloze.id));
  assert.deepEqual(await counts(app, headers), [{ lang: "pl", words: { due: 0, new: 1 }, forms: { due: 0, new: 1 } }]);

  await body("review", review(app, headers, answer(cloze.id, 1)));
  assert.deepEqual((await due(app, headers, "pl")).newLeft, { words: 0, forms: 0 });
  assert.deepEqual(await kinds("forms"), []);
  // Again: due within minutes, in the forms' group only
  const later = setup({ at: "2026-11-04T00:30:00Z" });
  assert.deepEqual(
    (await due(later, headers, "pl", { group: "forms" })).cards.map((c) => [c.id, c.isNew]),
    [[cloze.id, false]],
  );
  assert.deepEqual(
    (await due(later, headers, "pl", { group: "words" })).cards.map((c) => c.kind),
    ["production"],
  );
  assert.deepEqual((await counts(later, headers))[0], { lang: "pl", words: { due: 0, new: 1 }, forms: { due: 1, new: 0 } });
});

test("a cloze card of a word with no cards being learnt, none or all known, doesn't wait for them", async () => {
  const app = setup();
  const headers = await signedIn();
  const { cardId: alone } = await makeCloze(app, headers, "pl:pies:NOUN", 0);
  assert.deepEqual(
    (await due(app, headers, "pl", { group: "forms" })).cards.map((c) => c.id),
    [alone],
  );
  assert.deepEqual(
    (await wordCards(app, headers, "pl:pies:NOUN")).map((c) => c.kind),
    ["cloze"],
  );
  await learn(app, headers, "pl:kot:NOUN");
  const { cardId: known } = await makeCloze(app, headers, "pl:kot:NOUN", 1);
  assert.deepEqual(
    (await due(app, headers, "pl", { group: "forms" })).cards.map((c) => c.id),
    [alone],
  );
  for (const card of await wordCards(app, headers, "pl:kot:NOUN"))
    if (card.kind !== "cloze") await setState(app, headers, card.id, "known");
  assert.deepEqual((await due(app, headers, "pl", { group: "forms" })).cards.map((c) => c.id).sort(), [alone, known].sort());
});

test("each language is reviewed on its own, with its own daily allowance of new words", async () => {
  const app = setup();
  const headers = await signedIn();
  await saveSettings(app, headers, { newLemmasPerDay: 1 });
  await learn(app, headers, "pl:pies:NOUN");
  await learn(app, headers, "en:dog:NOUN");
  await learn(app, headers, "en:cat:NOUN");
  const words = (due: number, fresh: number) => ({ due, new: fresh });
  assert.deepEqual(await counts(app, headers), [
    { ...none("en"), words: words(0, 1) },
    { ...none("pl"), words: words(0, 1) },
  ]);
  const [polish] = (await due(app, headers, "pl")).cards;
  assert.equal(polish?.lemmaId, "pl:pies:NOUN");
  assert.equal((await review(app, headers, answer(polish.id, 1))).status, 200);
  // Again makes the Polish card due again within minutes, and its word's other card is still
  // new; English still has its own new word
  assert.deepEqual(await counts(setup({ at: "2026-11-04T00:30:00Z" }), headers), [
    { ...none("en"), words: words(0, 1) },
    { ...none("pl"), words: words(1, 1) },
  ]);
  assert.deepEqual(
    (await due(app, headers, "en")).cards.map((c) => c.lemmaId),
    ["en:cat:NOUN", "en:cat:NOUN"],
  );
});

test("Easy on a new card makes it mature", async () => {
  const app = setup();
  const headers = await signedIn();
  await learn(app, headers, "pl:pies:NOUN");
  const recognition = (await due(app, headers, "pl")).cards.find((c) => c.kind === "recognition");
  assert.ok(recognition);
  assert.equal((await review(app, headers, answer(recognition.id, 4))).status, 200);
  const [card] = (await wordCards(app, headers, "pl:pies:NOUN")).filter((c) => c.id === recognition.id);
  assert.ok(card && card.scheduledDays >= MATURE_DAYS);
});

test("a review needs a session, the user's card, a grade, and a time that isn't ahead or before the last review", async () => {
  const app = setup();
  assert.equal((await review(app, undefined, answer(crypto.randomUUID(), 3))).status, 401);
  const headers = await signedIn();
  await learn(app, headers, "pl:pies:NOUN");
  const [card] = (await due(app, headers, "pl")).cards;
  assert.ok(card);
  assert.equal((await review(app, headers, answer(crypto.randomUUID(), 3))).status, 404);
  assert.equal((await raw(app, "POST", "/api/me/reviews", headers, { ...answer(card.id, 3), rating: 0 })).status, 400);
  assert.equal((await raw(app, "POST", "/api/me/reviews", headers, { ...answer(card.id, 3), rating: 5 })).status, 400);
  assert.equal((await raw(app, "POST", "/api/me/reviews", headers, { ...answer(card.id, 3), id: "1" })).status, 400);
  assert.equal((await review(app, headers, answer(card.id, 3, "2026-11-04T01:00:00.000Z"))).status, 400);
  assert.equal((await review(app, headers, answer(card.id, 3, "2026-11-03T23:59:59.999Z"))).status, 409);
  const first = answer(card.id, 3);
  assert.equal((await review(app, headers, first)).status, 200);
  assert.equal((await review(app, headers, answer(card.id, 3, "2026-11-03T00:00:00.000Z"))).status, 409);
  const other = (await due(app, headers, "pl")).cards.find((c) => c.id !== card.id);
  assert.ok(other);
  assert.equal((await review(app, headers, { ...first, cardId: other.id })).status, 409);
  const bob = await local.signIn((await local.signUp({ name: "Bob", email: "bob@example.com" })).id);
  assert.equal((await review(app, bob, answer(card.id, 3))).status, 404);
});

test("cards and settings need a session and valid input", async () => {
  const app = setup();
  const anonymous = client(app);
  assert.equal((await anonymous.me.cards.due.$get({ query: { lang: "pl", dayStart: DAY_START } })).status, 401);
  assert.equal((await anonymous.me.cards.counts.$get({ query: { dayStart: DAY_START } })).status, 401);
  assert.equal((await anonymous.me.settings.$get()).status, 401);
  assert.equal((await makeCard(app, undefined, "pl:pies:NOUN", "recognition")).status, 401);
  const headers = await signedIn();
  // Invalid input, which the typed client won't send
  assert.equal((await raw(app, "POST", "/api/me/cards", headers, { kind: "recognition", lemmaId: "pies" })).status, 400);
  assert.equal((await raw(app, "POST", "/api/me/cards", headers, { kind: "recognition", lemmaId: "zz:pies:NOUN" })).status, 400);
  assert.equal((await raw(app, "POST", "/api/me/cards", headers, { kind: "recognition", lemmaId: "pl:pies:NOPE" })).status, 400);
  assert.equal((await raw(app, "POST", "/api/me/cards", headers, { kind: "known", lemmaId: "pl:pies:NOUN" })).status, 400);
  assert.equal((await raw(app, "POST", "/api/me/cards", headers, { lemmaId: "pl:pies:NOUN" })).status, 400);
  assert.equal((await raw(app, "POST", "/api/me/cards", headers, { kind: "cloze", lemmaId: "pl:pies:NOUN" })).status, 400);
  assert.equal((await raw(app, "POST", "/api/me/cards", headers, { kind: "cloze", lemmaId: "pl:pies:NOUN", data: {} })).status, 400);
  assert.equal(
    (await raw(app, "POST", "/api/me/cards", headers, { kind: "recognition", lemmaId: "pl:pies:NOUN", data: { why: null } })).status,
    400,
  );
  assert.equal((await makeCard(app, headers, "pl:i/lub:CCONJ", "recognition")).status, 201);
  assert.equal((await raw(app, "GET", "/api/me/cards/due", headers, undefined)).status, 400);
  assert.equal((await client(app, headers).me.cards.due.$get({ query: { lang: "pl", dayStart: "today" } })).status, 400);
  assert.equal((await raw(app, "GET", `/api/me/cards/due?dayStart=${DAY_START}`, headers, undefined)).status, 400);
  assert.equal((await raw(app, "GET", `/api/me/cards/due?lang=zz&dayStart=${DAY_START}`, headers, undefined)).status, 400);
  assert.equal((await raw(app, "GET", "/api/me/cards/counts", headers, undefined)).status, 400);
  assert.equal((await raw(app, "GET", `/api/me/cards/due?lang=pl&dayStart=${DAY_START}&group=all`, headers, undefined)).status, 400);
  for (const field of ["newLemmasPerDay", "newFormsPerDay"] as const) {
    assert.equal((await raw(app, "PUT", "/api/me/settings", headers, { ...DEFAULT_SETTINGS, [field]: -1 })).status, 400);
    assert.equal((await raw(app, "PUT", "/api/me/settings", headers, { ...DEFAULT_SETTINGS, [field]: 1.5 })).status, 400);
    assert.equal((await saveSettings(app, headers, { [field]: 1001 })).status, 400);
    const { [field]: _, ...missing } = DEFAULT_SETTINGS;
    assert.equal((await raw(app, "PUT", "/api/me/settings", headers, missing)).status, 400);
  }
  assert.equal((await raw(app, "PUT", "/api/me/settings", headers, { ...DEFAULT_SETTINGS, formsWithWords: 1 })).status, 400);
  const { formsWithWords: _, ...missing } = DEFAULT_SETTINGS;
  assert.equal((await raw(app, "PUT", "/api/me/settings", headers, missing)).status, 400);
  assert.deepEqual(await body("settings", client(app, headers).me.settings.$get()), DEFAULT_SETTINGS);
});

test("a word's cards come a page at a time, newest first, and no other word's", async () => {
  const app = setup();
  const headers = await signedIn();
  await learn(app, headers, "pl:pies:NOUN");
  await learn(app, headers, "pl:piesek:NOUN");
  const { cardId: cloze } = await makeCloze(setup({ at: "2026-11-04T01:00:00Z" }), headers, "pl:pies:NOUN", 0);
  const listed = await walk(1, (after?: Cursor<CardKey>) =>
    body("cards", client(app, headers).me.cards.$get({ query: { lemmaId: "pl:pies:NOUN", after, limit: "1" } })),
  );
  assert.deepEqual(
    listed.map((c) => c.lemmaId),
    ["pl:pies:NOUN", "pl:pies:NOUN", "pl:pies:NOUN"],
  );
  assert.equal(listed[0]?.id, cloze);
  assert.deepEqual(
    listed
      .slice(1)
      .map((c) => c.kind)
      .sort(),
    ["production", "recognition"],
  );
  assert.deepEqual(await wordCards(app, headers, "pl:kot:NOUN"), []);
  await refusesBadPages(CARD_PAGE.max, (query) => client(app, headers).me.cards.$get({ query: { lemmaId: "pl:pies:NOUN", ...query } }));
});

test("changing a card's state needs a session, the user's card and a state", async () => {
  const app = setup();
  const headers = await signedIn();
  await learn(app, headers, "pl:pies:NOUN");
  const [card] = await wordCards(app, headers, "pl:pies:NOUN");
  assert.ok(card);
  assert.equal((await setState(app, undefined, card.id, "known")).status, 401);
  const bob = await local.signIn((await local.signUp({ name: "Bob", email: "bob@example.com" })).id);
  assert.equal((await setState(app, bob, card.id, "known")).status, 404);
  assert.equal((await setState(app, headers, crypto.randomUUID(), "known")).status, 404);
  assert.equal((await raw(app, "PATCH", `/api/me/cards/${card.id}`, headers, { state: "ignored" })).status, 400);
  assert.equal((await raw(app, "PATCH", `/api/me/cards/${card.id}`, headers, {})).status, 400);
  assert.equal((await raw(app, "PATCH", "/api/me/cards/1", headers, { state: "known" })).status, 400);
  assert.equal((await setState(app, headers, card.id, "known")).status, 204);
  assert.equal((await setState(app, headers, card.id, "known")).status, 204);
  assert.deepEqual((await wordCards(app, headers, "pl:pies:NOUN")).find((c) => c.id === card.id)?.state, "known");
});

test("settings are saved whole, and kept", async () => {
  const app = setup();
  const headers = await signedIn();
  const saved: Settings = { newLemmasPerDay: 0, newFormsPerDay: MAX_NEW_PER_DAY, formsWithWords: false };
  assert.equal((await saveSettings(app, headers, saved)).status, 204);
  assert.deepEqual(await body("settings", client(app, headers).me.settings.$get()), saved);
  const bob = await local.signIn((await local.signUp({ name: "Bob", email: "bob@example.com" })).id);
  assert.deepEqual(await body("bob's settings", client(app, bob).me.settings.$get()), DEFAULT_SETTINGS);
});

test("a lexicon lookup gives each language's loaded version, leaving out ids it doesn't have", async () => {
  const app = setup();
  await loadLexicon("pl", "lex/1", [{ lemmaId: "pl:pies:NOUN", lemma: "pies", upos: "NOUN", gloss: "dog (old)" }]);
  await loadLexicon("pl", "lex/1", [], [{ Case: "Nom" }, { Case: "Gen" }]);
  await loadLexicon(
    "pl",
    "lex/2",
    [
      {
        lemmaId: "pl:pies:NOUN",
        lemma: "pies",
        upos: "NOUN",
        gloss: "dog",
        pronunciations: [{ ipa: "/ˈpjɛs/" }],
        paradigms: [
          {
            homonym: "",
            forms: [
              ["pies", [0]],
              ["psa", [1, 2]],
            ],
          },
        ],
      },
    ],
    [
      { Case: "Nom", Number: "Sing" },
      { Case: "Gen", Number: "Sing" },
      { Case: "Acc", Number: "Sing" },
      { Case: "Dat", Number: "Sing" },
    ],
  );
  await loadLexicon("en", "lex/1", [{ lemmaId: "en:dog:NOUN", lemma: "dog", upos: "NOUN", gloss: "a domesticated canid" }]);
  const { entries, featureSets } = await body("lookup", lookUp(app, ["pl:pies:NOUN", "en:dog:NOUN", "pl:kot:NOUN"]));
  assert.deepEqual(entries.map((e) => [e.lemmaId, e.senses[0]?.gloss]).sort(), [
    ["en:dog:NOUN", "a domesticated canid"],
    ["pl:pies:NOUN", "dog"],
  ]);
  const pies = entries.find((e) => e.lemmaId === "pl:pies:NOUN");
  assert.deepEqual(pies?.pronunciations, [{ ipa: "/ˈpjɛs/" }]);
  assert.deepEqual(pies?.paradigms, [
    {
      homonym: "",
      forms: [
        ["pies", [0]],
        ["psa", [1, 2]],
      ],
    },
  ]);
  // Only the sets the paradigms use, from the served version; dog has no paradigm
  assert.deepEqual(featureSets, {
    pl: { "0": { Case: "Nom", Number: "Sing" }, "1": { Case: "Gen", Number: "Sing" }, "2": { Case: "Acc", Number: "Sing" } },
  });
  assert.equal((await lookUp(app, [])).status, 400);
  assert.equal(
    (
      await lookUp(
        app,
        Array.from({ length: 101 }, (_, i): LemmaId => `pl:w${i}:NOUN`),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await lookUp(
        app,
        Array.from({ length: 100 }, (_, i): LemmaId => `pl:w${i}:NOUN`),
      )
    ).status,
    200,
  );
});

test("a word with no senses comes with the entries its relations point at, and a due card with them as related", async () => {
  const app = setup();
  const headers = await signedIn();
  await loadLexicon("pl", "lex/1", [
    {
      lemmaId: "pl:zgolić:VERB",
      lemma: "zgolić",
      upos: "VERB",
      gloss: null,
      relations: [
        { kind: "derived-from", targetId: "pl:golić:VERB", note: "perfective derivative", targetSenses: [0] },
        { kind: "derived-from", targetId: "pl:golnąć:" },
      ],
    },
    { lemmaId: "pl:golić:VERB", lemma: "golić", upos: "VERB", gloss: "to down" },
    { lemmaId: "pl:golnąć:", lemma: "golnąć", upos: null, gloss: null },
    {
      lemmaId: "pl:pies:NOUN",
      lemma: "pies",
      upos: "NOUN",
      gloss: "dog",
      relations: [{ kind: "derived-from", targetId: "pl:golić:VERB" }],
    },
  ]);
  const { entries } = await body("lookup", lookUp(app, ["pl:zgolić:VERB", "pl:pies:NOUN"]));
  assert.deepEqual(
    entries.map((e) => [e.lemmaId, e.relations] as const).sort(([a], [b]) => a.localeCompare(b)),
    [
      ["pl:golić:VERB", []],
      ["pl:pies:NOUN", [{ type: "derived-from", lemma: "golić", lemma_id: "pl:golić:VERB" }]],
      [
        "pl:zgolić:VERB",
        [
          { type: "derived-from", lemma: "golić", note: "perfective derivative", lemma_id: "pl:golić:VERB", sense_indexes: [0] },
          { type: "derived-from", lemma: "golnąć" },
        ],
      ],
    ],
  );
  await learn(app, headers, "pl:zgolić:VERB");
  const [card] = (await due(app, headers, "pl")).cards;
  assert.deepEqual(
    card?.related.map((e) => e.lemmaId),
    ["pl:golić:VERB"],
  );
});

test("a language's cards, of every kind, are listed newest first, a page at a time", async () => {
  const headers = await signedIn();
  await learn(setup(), headers, "pl:pies:NOUN");
  const later = setup({ at: "2026-11-04T01:00:00Z" });
  await learn(later, headers, "pl:kot:NOUN");
  const { cardId: cloze } = await makeCloze(setup({ at: "2026-11-04T02:00:00Z" }), headers, "pl:pies:NOUN", 0);
  const all = await listCards(later, headers, "pl");
  assert.deepEqual(
    all.map((c) => [c.createdAt, c.lemmaId, c.kind === "cloze"]),
    [
      ["2026-11-04T02:00:00.000Z", "pl:pies:NOUN", true],
      ["2026-11-04T01:00:00.000Z", "pl:kot:NOUN", false],
      ["2026-11-04T01:00:00.000Z", "pl:kot:NOUN", false],
      ["2026-11-04T00:00:00.000Z", "pl:pies:NOUN", false],
      ["2026-11-04T00:00:00.000Z", "pl:pies:NOUN", false],
    ],
  );
  // Made together, by id, last first
  assert.ok(all[1]!.id > all[2]!.id && all[3]!.id > all[4]!.id);
  assert.deepEqual(await listCards(later, headers, "pl", 2), all);
  assert.deepEqual(await listCards(later, headers, "pl", 1), all);
  assert.deepEqual(await listCards(later, headers, "en"), []);
  const [first] = all;
  assert.deepEqual(first, {
    id: cloze,
    lemmaId: "pl:pies:NOUN",
    kind: "cloze",
    createdAt: "2026-11-04T02:00:00.000Z",
    state: "learning",
    scheduleStatus: "new",
    dueAt: "2026-11-04T02:00:00.000Z",
    scheduledDays: 0,
    lastReviewedAt: null,
    data: first?.data,
  });
  assert.ok(first?.kind === "cloze");
  assert.equal(first.data.sentence, "Widzę psa.");
});

test("a listed card says whether it's known, where it is in its schedule and when it was last answered", async () => {
  const app = setup();
  const headers = await signedIn();
  await learn(app, headers, "pl:pies:NOUN");
  const recognition = (await listCards(app, headers, "pl")).find((c) => c.kind === "recognition");
  assert.ok(recognition);
  await body("review", review(app, headers, answer(recognition.id, 3)));
  const [card] = (await listCards(app, headers, "pl")).filter((c) => c.id === recognition.id);
  assert.equal(card?.scheduleStatus, "review");
  assert.equal(card.lastReviewedAt, "2026-11-04T00:00:00.000Z");
  assert.ok(card.dueAt > card.createdAt);
  assert.equal((await setState(app, headers, recognition.id, "known")).status, 204);
  assert.deepEqual((await listCards(app, headers, "pl")).map((c) => [c.kind, c.state]).sort(), [
    ["production", "learning"],
    ["recognition", "known"],
  ]);
});

test("deleting a card takes it and its reviews away, and making it again makes it anew", async () => {
  const app = setup();
  const headers = await signedIn();
  await learn(app, headers, "pl:pies:NOUN");
  const recognition = (await listCards(app, headers, "pl")).find((c) => c.kind === "recognition");
  assert.ok(recognition);
  await body("review", review(app, headers, answer(recognition.id, 3)));
  const bob = await local.signIn((await local.signUp({ name: "Bob", email: "bob@example.com" })).id);
  assert.equal((await deleteCard(app, bob, recognition.id)).status, 404);
  assert.equal((await deleteCard(app, undefined, recognition.id)).status, 401);
  assert.equal((await deleteCard(app, headers, recognition.id)).status, 204);
  assert.equal((await deleteCard(app, headers, recognition.id)).status, 404);
  assert.equal((await review(app, headers, answer(recognition.id, 3))).status, 404);
  assert.deepEqual(
    (await listCards(app, headers, "pl")).map((c) => c.kind),
    ["production"],
  );
  assert.deepEqual(
    (await due(app, headers, "pl")).cards.map((c) => c.kind),
    ["production"],
  );
  const { cardId } = await body("again", makeCard(app, headers, "pl:pies:NOUN", "recognition"), 201);
  assert.notEqual(cardId, recognition.id);
  const again = (await listCards(app, headers, "pl")).find((c) => c.kind === "recognition");
  assert.equal(again?.id, cardId);
  assert.equal(again.scheduleStatus, "new");
});

test("a list of cards needs a session, one of a language, a word and a text, and a cursor from the same kind of list", async () => {
  const app = setup();
  assert.equal((await client(app).me.cards.$get({ query: { lang: "pl" } })).status, 401);
  const headers = await signedIn();
  const cards = client(app, headers).me.cards;
  const refused = async (query: Parameters<typeof cards.$get>[0]["query"], error: string) =>
    assert.deepEqual(await body(JSON.stringify(query), cards.$get({ query }), 400), { error });
  const one = "give one of lang, lemmaId and documentId";
  await refused({}, one);
  await refused({ lang: "pl", documentId: "a".repeat(64) }, one);
  await refused({ lang: "pl", lemmaId: "pl:pies:NOUN" }, one);
  await refused({ lemmaId: "pl:pies:NOUN", documentId: "a".repeat(64) }, one);
  assert.equal((await cards.$get({ query: { lemmaId: "pies" as LemmaId } })).status, 400);
  assert.equal((await cards.$get({ query: { lang: "zz" as Lang } })).status, 400);
  await refusesBadPages(CARD_PAGE.max, (query) => cards.$get({ query: { lang: "pl", ...query } }));

  await makeCloze(app, headers, "pl:pies:NOUN", 0);
  await makeCloze(app, headers, "pl:pies:NOUN", 1);
  const newest = await body("newest", cards.$get({ query: { lang: "pl", limit: "1" } }));
  assert.ok(newest.next);
  const cloze = (await listCards(app, headers, "pl")).find((c) => c.kind === "cloze");
  assert.ok(cloze?.kind === "cloze");
  const { documentId } = cloze.data;
  await refused({ documentId, after: newest.next }, "after isn't a cursor this list gave");
});

test("a user has at most MAX_CARDS cards, of every kind", async () => {
  const app = setup();
  const { id: user } = await local.signUp(ALICE);
  const headers = await local.signIn(user);
  const documentId = await importSentences(app, headers, [sentenceAt(0), sentenceAt(1)]);
  const { cardId } = await body("word card", makeCard(app, headers, "pl:pies:NOUN", "recognition"), 201);
  const cloze = await body("cloze card", postCloze(app, headers, "pl:pies:NOUN", clozeAt(documentId, 0)), 201);
  const storage = await local.server.getWorker().getDurableObjectStorage("User", { name: user });
  await storage.exec(
    `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO card (id, lemma_id, kind, created_at, active, fsrs)
     SELECT 'more' || i, 'pl:more' || i || ':NOUN', kind, created_at, active, fsrs FROM card, n WHERE id = ?`,
    MAX_CARDS - 2,
    cardId,
  );
  const full = await expectStatus("full", makeCard(app, headers, "pl:kot:NOUN", "recognition"), 409);
  assert.deepEqual(await full.json(), { error: `a user has at most ${MAX_CARDS} cards` });
  await expectStatus("full, for a cloze card", postCloze(app, headers, "pl:kot:NOUN", clozeAt(documentId, 1)), 409);
  assert.deepEqual(await wordCards(app, headers, "pl:kot:NOUN"), []);
  assert.deepEqual(await body("a word card it has", makeCard(app, headers, "pl:pies:NOUN", "recognition")), { cardId });
  assert.deepEqual(await body("a cloze card it has", postCloze(app, headers, "pl:pies:NOUN", clozeAt(documentId, 0))), cloze);
  await expectStatus("deletes one", deleteCard(app, headers, cardId), 204);
  await body("room again", postCloze(app, headers, "pl:kot:NOUN", clozeAt(documentId, 1)), 201);
  await expectStatus("full again", makeCard(app, headers, "pl:kot:NOUN", "recognition"), 409);
});
