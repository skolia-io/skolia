// What the signed-in user knows of words: the word sheet asks for its words' cards, makes a
// word's cards and takes them away, and Review marks a word known.
import { createMutation, createQuery, mutationOptions } from "@tanstack/svelte-query";
import { WORD_CARD_KINDS, type Card, type LemmaId } from "@skolia/shared/api";
import { deleteCard, listWordCards, makeCard, setWordState } from "./api.ts";
import { cardsChanged, userQuery } from "./queries.ts";

const WORD_CARDS_KEY = ["me", "cards", "word"] as const;

/** Each word's cards, by lemma id. */
export type WordCards = ReadonlyMap<LemmaId, readonly Card[]>;

/** new: the word has no cards. learning or known: the word's state, which each of its cards has. */
export type WordState = "new" | "learning" | "known";

export function wordState(cards: readonly Card[] | undefined): WordState {
  if (!cards || cards.length === 0) return "new";
  return cards.some((c) => c.state === "learning") ? "learning" : "known";
}

/** The words' cards. data is null when signed out, undefined while loading. */
export function createWordCards(lemmaIds: () => readonly LemmaId[]) {
  const user = createQuery(() => userQuery);
  return createQuery(() => {
    const ids = [...new Set(lemmaIds())].sort();
    return {
      queryKey: [...WORD_CARDS_KEY, ...ids],
      queryFn: async (): Promise<WordCards | null> => {
        const lists = await Promise.all(ids.map(async (id) => [id, await listWordCards(id)] as const));
        return lists.some(([, cards]) => cards === null) ? null : new Map(lists.map(([id, cards]) => [id, cards ?? []]));
      },
      enabled: user.data != null,
    };
  });
}

/** Makes the word's recognition and production cards, or keeps those it has. */
const learnMutation = mutationOptions({
  mutationFn: (lemmaId: LemmaId) => Promise.all(WORD_CARD_KINDS.map((kind) => makeCard({ kind, lemmaId }))),
  onSettled: (_made, _error, _lemmaId, _held, { client }) => cardsChanged(client),
});

export function createLearnWord() {
  return createMutation(() => learnMutation);
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
