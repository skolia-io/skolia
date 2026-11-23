import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LANGS, lemmaParam, type CardCounts, type CardKey, type Due, type Lang } from "@skolia/shared/api";
import { allPages, type Cursor } from "@skolia/shared/page";
import { e2eUserKey } from "@skolia/api/e2e-keys";
import { body, expectStatus } from "@skolia/util/responses";
import { client } from "./client.ts";
import { WORDS } from "./words.ts";

/** The start of today in UTC: when today's new cards count from. */
function dayStart(): string {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return today.toISOString();
}

/** A new user's journey with one word: make its cards, review one, mark it known. */
async function cards(key: string, lang: Lang): Promise<void> {
  const api = client(key);
  const word = WORDS[lang];
  const startOfDay = dayStart();
  const due = async (): Promise<Due> =>
    // Hono's JSON type makes the entries' optional fields `| undefined`; it's the same JSON
    (await body(`${lang} cards due`, api.me.cards.due.$get({ query: { lang, dayStart: startOfDay } }))) as Due;
  const counts = async (): Promise<CardCounts | undefined> =>
    (await body("card counts", api.me.cards.counts.$get({ query: { dayStart: startOfDay } }))).find((c) => c.lang === lang);
  const wordCards = () =>
    allPages((after?: Cursor<CardKey>) => body(`${word}'s cards`, api.me.cards.$get({ query: { lemmaId: word, after } })));
  const review = (cardId: string, id: string) =>
    body(`${lang} review`, api.me.reviews.$post({ json: { id, cardId, rating: 3, at: new Date().toISOString() } }));

  const { newLemmasPerDay } = await body("settings", api.me.settings.$get());
  assert.ok(newLemmasPerDay >= 1, `${lang}: a new user's settings allow ${newLemmasPerDay} new words a day`);
  assert.equal(await counts(), undefined, `${lang}: a new user has cards`);

  for (const kind of ["recognition", "production"] as const) {
    await expectStatus(`making ${word}'s ${kind} card`, api.me.cards.$post({ json: { kind, lemmaId: word } }), 201);
  }
  assert.deepEqual(
    (await wordCards()).map((c) => [c.kind, c.state]).sort(),
    [
      ["production", "learning"],
      ["recognition", "learning"],
    ],
    `${lang}: ${word}'s cards`,
  );
  assert.deepEqual(await counts(), { lang, due: 0, new: 2 }, `${lang}: counts after adding a word`);

  const added = await due();
  assert.deepEqual(new Set(added.cards.map((c) => c.kind)), new Set(["recognition", "production"]), `${lang}: card kinds`);
  for (const card of added.cards) {
    assert.ok(card.isNew, `${lang}: an added word's card isn't new`);
    assert.deepEqual(
      card.entries.map((e) => e.lemma_id),
      [word],
      `${lang}: a card without its lexicon entry`,
    );
  }
  assert.ok(Object.keys(added.featureSets).length > 0, `${lang}: due cards without feature sets`);

  const [card, other] = added.cards;
  if (!card || !other) throw new Error(`${lang}: ${added.cards.length} cards, expected 2`);
  const id = crypto.randomUUID();
  const { dueAt } = await review(card.id, id);
  assert.ok(Date.parse(dueAt) > Date.now(), `${lang}: a reviewed card is due again at once (${dueAt})`);
  assert.equal((await review(card.id, id)).dueAt, dueAt, `${lang}: a retried review rescheduled the card`);
  assert.deepEqual(
    (await due()).cards.map((c) => c.id),
    [other.id],
    `${lang}: due after a review`,
  );

  await expectStatus(
    `marking ${word} known`,
    api.me.words[":lemmaId"].$patch({ param: { lemmaId: lemmaParam(word) }, json: { state: "known" } }),
    204,
  );
  assert.deepEqual((await due()).cards, [], `${lang}: a known word's cards are due`);
  assert.deepEqual(await counts(), { lang, due: 0, new: 0 }, `${lang}: counts after marking a word known`);
}

describe("card journeys", { concurrency: LANGS.length }, () => {
  const seed = process.env["E2E_USER_KEY"];
  assert.ok(seed, "E2E_USER_KEY is required");
  for (const lang of LANGS) test(lang, () => cards(e2eUserKey(seed, lang), lang));
});
