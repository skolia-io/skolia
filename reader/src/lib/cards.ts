// The signed-in user's cards in a language, a page at a time with the lexicon entries they
// show, and deleting one. A deleted card leaves the pages at once; the text's cloze cards
// and the review counts are asked for again.
import {
  createInfiniteQuery,
  createMutation,
  createQuery,
  keepPreviousData,
  mutationOptions,
  skipToken,
  type InfiniteData,
} from "@tanstack/svelte-query";
import type { Card, CardId, CardKey, Lang, Paginated } from "@skolia/shared/api";
import type { Entry } from "@skolia/shared/schema";
import type { Cursor } from "@skolia/shared/page";
import { deleteCard, listCards, lookUp } from "./api.ts";
import { cardsChanged, userQuery } from "./queries.ts";

const LISTS_KEY = ["me", "cards", "list"] as const;

/** A page of cards, and the lexicon's entries for their lemmas, by lemma id. */
export type CardPage = Paginated<Card, CardKey> & { readonly entries: ReadonlyMap<string, Entry> };

async function cardPage(lang: Lang, after: Cursor<CardKey> | undefined): Promise<CardPage> {
  const page = await listCards(lang, after);
  const ids = [...new Set(page.items.map((c) => c.lemmaId))];
  const found = ids.length === 0 ? [] : (await lookUp(ids)).entries;
  return { ...page, entries: new Map(found.map((entry) => [entry.lemma_id, entry])) };
}

/** A language's cards, newest first. Another language's list shows the last one's until
 * it comes. */
export function createCardList(lang: () => Lang | null) {
  const user = createQuery(() => userQuery);
  return createInfiniteQuery(() => {
    const selected = lang();
    return {
      enabled: user.data != null,
      queryKey: [...LISTS_KEY, selected] as const,
      queryFn: selected === null ? skipToken : ({ pageParam }: { pageParam: Cursor<CardKey> | undefined }) => cardPage(selected, pageParam),
      initialPageParam: undefined as Cursor<CardKey> | undefined,
      getNextPageParam: (page: CardPage) => page.next ?? undefined,
      placeholderData: keepPreviousData,
    };
  });
}

const deleteMutation = mutationOptions({
  mutationFn: (cardId: CardId) => deleteCard(cardId),
  onSuccess: (_deleted, cardId, _held, { client }) => {
    client.setQueriesData<InfiniteData<CardPage, Cursor<CardKey> | undefined>>(
      { queryKey: LISTS_KEY },
      (data) => data && { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.filter((c) => c.id !== cardId) })) },
    );
    cardsChanged(client);
  },
});

/** Deletes a card of any kind, with its reviews. A word card's word keeps its status. */
export function createDeleteCard() {
  return createMutation(() => deleteMutation);
}
