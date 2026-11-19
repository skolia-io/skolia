import { createQuery, createMutation, createInfiniteQuery, queryOptions } from "@tanstack/svelte-query";
import type { DocumentId, ReadingList, ReadingListId, Lang, ReadingKey } from "@skolia/shared/api";
import type { Cursor } from "@skolia/shared/page";
import * as api from "./api.ts";
import { userQuery } from "./queries.ts";

const READING_LISTS_KEY = ["me", "reading-lists"] as const;
const readingListsQuery = queryOptions({ queryKey: [...READING_LISTS_KEY, "all"], queryFn: api.readingLists });
const membershipKey = (id: DocumentId) => [...READING_LISTS_KEY, "memberships", id] as const;
const documentsKey = (id: ReadingListId) => [...READING_LISTS_KEY, "documents", id] as const;
export function findReadingLists(lists: readonly ReadingList[] = [], search: string): readonly ReadingList[] {
  const needle = search.trim().toLocaleLowerCase();
  return lists
    .filter((list) => list.name.toLocaleLowerCase().includes(needle))
    .toSorted((a, b) => Number(b.id === "to-read") - Number(a.id === "to-read") || a.name.localeCompare(b.name));
}

export function queryReadingLists(enabled: () => boolean = () => true) {
  const user = createQuery(() => userQuery);
  return createQuery(() => ({ ...readingListsQuery, enabled: user.data != null && enabled() }));
}
export function createMemberships(id: () => DocumentId, enabled: () => boolean) {
  const user = createQuery(() => userQuery);
  return createQuery(() => ({
    queryKey: membershipKey(id()),
    queryFn: () => api.readingListMemberships(id()),
    enabled: user.data != null && enabled(),
  }));
}
export function createReadingListChange() {
  return createMutation(() => ({
    mutationFn: ({ listId, id, saved }: { readonly listId: ReadingListId; readonly id: DocumentId; readonly saved: boolean }) =>
      api.setReadingListDocument(listId, id, saved),
    onSuccess: async (_data, { listId, id }, _held, { client }) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: membershipKey(id) }),
        client.invalidateQueries({ queryKey: documentsKey(listId) }),
        client.invalidateQueries({ queryKey: readingListsQuery.queryKey }),
      ]);
    },
  }));
}
export function createReadingListEdit() {
  return createMutation(() => ({
    mutationFn: async (
      change:
        | { readonly action: "create"; readonly name: string }
        | { readonly action: "rename"; readonly id: ReadingListId; readonly name: string }
        | { readonly action: "delete"; readonly id: ReadingListId },
    ): Promise<ReadingListId | void> => {
      switch (change.action) {
        case "create":
          return api.createReadingList(change.name);
        case "rename":
          return api.renameReadingList(change.id, change.name);
        case "delete":
          return api.deleteReadingList(change.id);
      }
    },
    onSuccess: (_data, change, _held, { client }) =>
      client.invalidateQueries({ queryKey: change.action === "delete" ? READING_LISTS_KEY : readingListsQuery.queryKey }),
  }));
}
export function createReadingListDocuments(id: () => ReadingListId, lang: () => Lang | undefined) {
  return createInfiniteQuery(() => ({
    queryKey: [...documentsKey(id()), lang()],
    queryFn: ({ pageParam }) => api.readingListDocuments(id(), lang(), pageParam),
    initialPageParam: undefined as Cursor<ReadingKey> | undefined,
    getNextPageParam: (page) => page.next ?? undefined,
  }));
}
