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
  type QueryClient,
  type InfiniteData,
} from "@tanstack/svelte-query";
import { langOf, type Card, type CardId, type CardKey, type Lang, type LemmaId, type Paginated } from "@skolia/shared/api";
import type { Entry } from "@skolia/shared/schema";
import type { Cursor } from "@skolia/shared/page";
import { deleteCard, LexiconVersionChanged, listCards } from "./api.ts";
import { entryQuery, lexiconInfoQuery } from "./lexicon.ts";
import { cardsChanged, userQuery } from "./queries.ts";

const LISTS_KEY = ["me", "cards", "list"] as const;

/** A page of cards, and the lexicon's entries for their lemmas, by lemma id. */
export type CardPage = Paginated<Card, CardKey> & { readonly entries: ReadonlyMap<LemmaId, Entry> };

async function cardPage(client: QueryClient, lang: Lang, after: Cursor<CardKey> | undefined): Promise<CardPage> {
  const page = await listCards(lang, after);
  const ids = [...new Set(page.items.flatMap((c) => c.lemmaIds))];
  const langs = [...new Set(ids.map(langOf))];
  async function load() {
    const versions = new Map(
      await Promise.all(
        langs.map(async (lang) => {
          const info = await client.fetchQuery({ ...lexiconInfoQuery(lang), staleTime: 0 });
          return [lang, info?.version ?? null] as const;
        }),
      ),
    );
    return Promise.all(
      ids.map(async (id) => {
        const response = await client.fetchQuery(entryQuery(client, id, versions.get(langOf(id)) ?? null));
        return [id, response?.entries[0]] as const;
      }),
    );
  }
  const found = await load().catch((error: unknown) => {
    if (error instanceof LexiconVersionChanged) return load();
    throw error;
  });
  return { ...page, entries: new Map(found.flatMap(([id, entry]) => (entry === undefined ? [] : [[id, entry]]))) };
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
      queryFn: selected === null ? skipToken : ({ pageParam, client }) => cardPage(client, selected, pageParam),
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
