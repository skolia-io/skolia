// The signed-in user's cloze cards in a text, by where their blanks start in it, so the word
// sheet can say a word already has one, and take it away. Reader loads them with the text.
import { createMutation, createQuery, mutationOptions, queryOptions } from "@tanstack/svelte-query";
import type { CardId, DocumentId, LemmaId, NewClozeInput } from "@skolia/shared/api";
import { deleteCard, listTextCards, makeCard } from "./api.ts";
import { CLOZES_KEY, cardsChanged, resume, userQuery } from "./queries.ts";

export type ClozesByStart = ReadonlyMap<number, CardId>;

function clozesQuery(documentId: DocumentId) {
  return queryOptions({
    queryKey: [...CLOZES_KEY, documentId],
    queryFn: async (): Promise<ClozesByStart | null> => {
      const list = await listTextCards(documentId);
      return list && new Map(list.flatMap((c) => (c.cloze ? [[c.cloze.blankStart, c.id] as const] : [])));
    },
  });
}

/** data is null when signed out, undefined while loading. */
export function createClozes(documentId: () => DocumentId) {
  const user = createQuery(() => userQuery);
  return createQuery(() => ({ ...clozesQuery(documentId()), enabled: user.data != null }));
}

const keyOf = (documentId: DocumentId) => clozesQuery(documentId).queryKey;

/** The card's id comes from the API, so it's added once made. */
const addMutation = mutationOptions({
  mutationFn: (cloze: NewClozeInput & { readonly lemmaId: LemmaId; readonly documentId: DocumentId }) =>
    makeCard({ kind: "cloze", ...cloze }),
  onMutate: async (cloze, { client }) => {
    await client.cancelQueries({ queryKey: keyOf(cloze.documentId) });
  },
  onSuccess: ({ cardId }, cloze, _held, { client }) =>
    client.setQueryData(keyOf(cloze.documentId), (byStart) => byStart && new Map([...byStart, [cloze.blankStart, cardId]])),
  onSettled: (_made, _error, cloze, _held, { client }) => {
    resume(client, keyOf(cloze.documentId));
    cardsChanged(client);
  },
});

export function createAddCloze() {
  return createMutation(() => addMutation);
}

/** The text's cloze card at start. */
export type ClozeRemoval = { readonly documentId: DocumentId; readonly start: number; readonly cardId: CardId };

const removeMutation = mutationOptions({
  mutationFn: ({ cardId }: ClozeRemoval) => deleteCard(cardId),
  onMutate: async ({ documentId, start }, { client }) => {
    await client.cancelQueries({ queryKey: keyOf(documentId) });
    client.setQueryData(keyOf(documentId), (byStart) => byStart && new Map([...byStart].filter(([s]) => s !== start)));
  },
  onError: (_error, { documentId, start, cardId }, _held, { client }) =>
    client.setQueryData(keyOf(documentId), (byStart) => byStart && new Map([...byStart, [start, cardId]])),
  onSettled: (_data, _error, { documentId }, _held, { client }) => {
    resume(client, keyOf(documentId));
    cardsChanged(client);
  },
});

/** Deletes a cloze card, with its reviews: gone at once, and back if the API refuses. */
export function createRemoveCloze() {
  return createMutation(() => removeMutation);
}
