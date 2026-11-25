// What the signed-in user knows of words: the word sheet asks for its words, with their
// cards, makes a word's cards and takes them away, and learns a known word again; Review
// marks a word known.
import { createMutation, createQuery, mutationOptions } from "@tanstack/svelte-query";
import { WORD_CARD_KINDS, type Card, type LemmaId } from "@skolia/shared/api";
import { deleteCard, listWordCards, listWords, makeCard, setWordState } from "./api.ts";
import { cardsChanged, userQuery } from "./queries.ts";
import type { UserWord, UserWords } from "./word-state.ts";

const WORD_CARDS_KEY = ["me", "cards", "word"] as const;

/** The words the user has of these, with their cards. data is null when signed out,
 * undefined while loading. Only the words with cards have them listed. */
export function createUserWords(lemmaIds: () => readonly LemmaId[]) {
  const user = createQuery(() => userQuery);
  return createQuery(() => {
    const ids = [...new Set(lemmaIds())].sort();
    return {
      queryKey: [...WORD_CARDS_KEY, ...ids],
      queryFn: async (): Promise<UserWords | null> => {
        const words = await listWords(ids);
        if (words === null) return null;
        const listed = await Promise.all(
          words.map(async (word) => ({ ...word, listed: word.cards > 0 ? await listWordCards(word.lemmaId) : [] })),
        );
        return listed.some((word) => word.listed === null)
          ? null
          : new Map(listed.map((word): [LemmaId, UserWord] => [word.lemmaId, { state: word.state, cards: word.listed ?? [] }]));
      },
      enabled: user.data != null,
    };
  });
}

function makeWordCards(lemmaId: LemmaId) {
  return Promise.all(WORD_CARD_KINDS.map((kind) => makeCard({ kind, lemmaId })));
}

/** Makes the word's recognition and production cards, or keeps those it has. */
const learnMutation = mutationOptions({
  mutationFn: makeWordCards,
  onSettled: (_made, _error, _lemmaId, _held, { client }) => cardsChanged(client),
});

export function createLearnWord() {
  return createMutation(() => learnMutation);
}

/** Puts a known word back in reviews, and makes its recognition and production cards if it
 * has none. */
const learnAgainMutation = mutationOptions({
  mutationFn: async ({ lemmaId, word }: { readonly lemmaId: LemmaId; readonly word: UserWord }) => {
    await setWordState(lemmaId, "learning");
    if (word.cards.length === 0) await makeWordCards(lemmaId);
  },
  onSettled: (_done, _error, _word, _held, { client }) => cardsChanged(client),
});

export function createLearnAgain() {
  return createMutation(() => learnAgainMutation);
}

/** Deletes the cards, with their reviews. */
const forgetMutation = mutationOptions({
  mutationFn: (cards: readonly Card[]) => Promise.all(cards.map((c) => deleteCard(c.id))),
  onSettled: (_deleted, _error, _cards, _held, { client }) => cardsChanged(client),
});

export function createForgetCards() {
  return createMutation(() => forgetMutation);
}

/** Marks the word known, which takes its cards out of reviews. */
const knownMutation = mutationOptions({
  mutationFn: (lemmaId: LemmaId) => setWordState(lemmaId, "known"),
  onSettled: (_done, _error, _lemmaId, _held, { client }) => cardsChanged(client),
});

export function createMarkKnown() {
  return createMutation(() => knownMutation);
}
