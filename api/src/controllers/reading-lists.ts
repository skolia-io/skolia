import {
  timestamp,
  type User,
  type ReadingListId,
  type DocumentId,
  type Lang,
  type ReadingKey,
  type ReadingListDocument,
} from "@skolia/shared/api";
import type { PageRequest } from "@skolia/shared/page";
import type { Deps } from "../ports.ts";
import { listed } from "./documents.ts";
import { ok, fail, NO_CONTENT } from "./result.ts";

export async function all(deps: Deps, user: User) {
  return ok({ lists: await deps.users.readingLists(user.id) });
}

export async function create(deps: Deps, user: User, name: string) {
  const id = await deps.users.createReadingList(user.id, name, timestamp(deps.now()));
  return id === null ? fail(409, "You can have up to 200 reading lists.") : ok({ id });
}

export async function rename(deps: Deps, user: User, id: ReadingListId, name: string) {
  return (await deps.users.renameReadingList(user.id, id, name)) ? NO_CONTENT : fail(404, "No such reading list");
}

export async function remove(deps: Deps, user: User, id: ReadingListId) {
  return (await deps.users.deleteReadingList(user.id, id)) ? NO_CONTENT : fail(404, "No such reading list");
}

export async function memberships(deps: Deps, user: User, documentId: DocumentId) {
  return ok({ lists: await deps.users.readingListMemberships(user.id, documentId) });
}

export async function save(deps: Deps, user: User, id: ReadingListId, documentId: DocumentId, saved: boolean) {
  // Removal remains possible after a text becomes unavailable.
  const document = saved ? await deps.documents.visible(documentId, user.id) : null;
  if (saved && !document) return fail(404, "No such document");
  return (await deps.users.setReadingListDocument(
    user.id,
    id,
    documentId,
    document ? { lang: document.lang, createdAt: timestamp(deps.now()) } : null,
  ))
    ? NO_CONTENT
    : fail(404, "No such reading list");
}

export async function documents(deps: Deps, user: User, id: ReadingListId, lang: Lang | undefined, page: PageRequest<ReadingKey>) {
  const found = await deps.users.readingListDocuments(user.id, id, lang, page);
  if (!found) return fail(404, "No such reading list");
  const documents = await deps.documents.visibleAll(
    found.items.map((item) => item.documentId),
    user.id,
  );
  const items = found.items.flatMap(({ documentId, createdAt }) => {
    const record = documents.get(documentId);
    return record === undefined ? [] : [{ document: listed(record, user), createdAt } satisfies ReadingListDocument];
  });
  return ok({ items, next: found.next });
}
