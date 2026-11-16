// The signed-in user's cloze cards in a text, by where their blanks start in it, so the word
// sheet can say a word already has one, and take it away. Reader loads them with the text.
import { createMutation, createQuery, mutationOptions, queryOptions } from "@tanstack/svelte-query";
import type { CardId, DocumentId, LemmaId, NewClozeInput } from "@skolia/shared/api";
import { deleteCard, listTextCards, makeCloze } from "./api.ts";
import { resume, userQuery } from "./queries.ts";
import { activateUnmarked, resumeWords, unmark } from "./words.ts";

export type ClozesByStart = ReadonlyMap<number, CardId>;

/** Every text's cloze cards, for a change made elsewhere to ask for again. */
export const CLOZES_KEY = ["me", "clozes"] as const;

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

/** The card's id comes from the API, so it's added once made. Its word, if it has no
 * status, is made active with it, as the API does. */
const addMutation = mutationOptions({
  mutationFn: makeCloze,
  onMutate: async (cloze: NewClozeInput & { readonly lemmaId: LemmaId; readonly documentId: DocumentId }, { client }) => {
    await client.cancelQueries({ queryKey: keyOf(cloze.documentId) });
    return { activated: await activateUnmarked(client, cloze.lemmaId) };
  },
  onSuccess: ({ cardId }, cloze, _held, { client }) =>
    client.setQueryData(keyOf(cloze.documentId), (byStart) => byStart && new Map([...byStart, [cloze.blankStart, cardId]])),
  onError: (_error, cloze, held, { client }) => {
    if (held?.activated) unmark(client, cloze.lemmaId);
  },
  onSettled: (_made, _error, cloze, _held, { client }) => {
    resume(client, keyOf(cloze.documentId));
    resumeWords(client);
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
  onSettled: (_data, _error, { documentId }, _held, { client }) => resume(client, keyOf(documentId)),
});

/** Deletes a cloze card, with its reviews: gone at once, and back if the API refuses. */
export function createRemoveCloze() {
  return createMutation(() => removeMutation);
}
