// What the reader asks the API for, as TanStack Query options. Keys under "me" are the
// signed-in user's; signing out forgets everything but who's signed in.
import { QueryClient, queryOptions, skipToken, type QueryKey } from "@tanstack/svelte-query";
import type { CardGroup, DocumentId, Lang } from "@skolia/shared/api";
import { audioAnnotations } from "./annotations.ts";
import { cardCounts, currentUser, dueCards, getConfig, getIngest, getSettings, getVersion, listAnnotations, listTags } from "./api.ts";
import { shuffled } from "./review.ts";

/** No retries and no refetch on focus: a failure shows at once, as the page's own error. */
export function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
}

/** null when signed out. */
export const userQuery = queryOptions({ queryKey: ["user"], queryFn: currentUser, staleTime: Infinity });

export const tagsQuery = queryOptions({ queryKey: ["tags"], queryFn: listTags, staleTime: Infinity });

export const versionQuery = queryOptions({ queryKey: ["version"], queryFn: getVersion, staleTime: Infinity });

/** The deployment's config, which changes only with a deploy. */
export const configQuery = queryOptions({ queryKey: ["config"], queryFn: getConfig, staleTime: Infinity });

export const settingsQuery = queryOptions({ queryKey: ["me", "settings"], queryFn: getSettings });

/** What analysis is doing, asked for again every few seconds while it's shown. */
export const ingestQuery = queryOptions({ queryKey: ["ingest"], queryFn: getIngest, refetchInterval: 5000 });

/** The text's audio annotations, from the entry the viewer sees for it. */
export function audioQuery(id: DocumentId) {
  return queryOptions({ queryKey: ["annotations", id], queryFn: async () => audioAnnotations(await listAnnotations(id)) });
}

/** Every text's cloze cards (lib/clozes.ts). */
export const CLOZES_KEY = ["me", "clozes"] as const;

/** After a card is made, changed or deleted: what's shown of the user's cards is asked for
 * again, but not a review session, which takes its cards out itself. */
export function cardsChanged(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: ["me", "cards"], predicate: ({ queryKey }) => queryKey[2] !== "due" });
  void client.invalidateQueries({ queryKey: CLOZES_KEY });
}

export const countsQuery = queryOptions({ queryKey: ["me", "cards", "counts"], queryFn: () => cardCounts() });

/** A review session's cards, shuffled, taken out as they're reviewed, and asked for afresh
 * only by Check again or by coming back to them. None until there's a language. */
export function dueQuery(lang: Lang | null, group: CardGroup | null) {
  return queryOptions({
    queryKey: ["me", "cards", "due", lang, group],
    queryFn: lang
      ? async () => {
          const due = await dueCards(lang, group);
          return due && { ...due, cards: shuffled(due.cards) };
        }
      : skipToken,
    staleTime: Infinity,
    gcTime: 0,
  });
}

/** A change cancels the load in flight, which may have started before it and would undo
 * it; this loads again one cancelled before it had anything. */
export function resume(client: QueryClient, queryKey: QueryKey): void {
  if (client.getQueryData(queryKey) === undefined) void client.invalidateQueries({ queryKey });
}

/** After signing out: the user's own queries go, and the rest, which may hold their
 * private texts, are asked for again. */
export async function forgetUser(client: QueryClient): Promise<void> {
  client.setQueryData(userQuery.queryKey, null);
  client.removeQueries({ queryKey: ["me"] });
  await client.resetQueries({ predicate: ({ queryKey: [first] }) => first !== "user" && first !== "me" });
}
