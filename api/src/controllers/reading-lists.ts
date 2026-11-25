import {
  timestamp,
  type Identity,
  type ReadingListId,
  type DocumentId,
  type Lang,
  type ReadingKey,
  type ReadingListDocument,
} from "@skolia/shared/api";
import type { PageRequest } from "@skolia/shared/page";
import type { Clock } from "../ports/index.ts";
import type { DocumentLookup } from "../ports/documents.ts";
import type { ReadingLists } from "../ports/users.ts";
import { listed } from "./documents.ts";
import { ok, fail, NO_CONTENT } from "./result.ts";

export async function all(deps: { users: ReadingLists }, user: Identity) {
  return ok({ lists: await deps.users.readingLists(user.id) });
}

export async function create(deps: { users: ReadingLists } & Clock, user: Identity, name: string) {
  const id = await deps.users.createReadingList(user.id, name, timestamp(deps.now()));
  return id === null ? fail(409, { code: "limit-exceeded", resource: "reading-lists", limit: 200 }) : ok({ id });
}

export async function rename(deps: { users: ReadingLists }, user: Identity, id: ReadingListId, name: string) {
  return (await deps.users.renameReadingList(user.id, id, name)) ? NO_CONTENT : fail(404, { code: "reading-list-not-found" });
}

export async function remove(deps: { users: ReadingLists }, user: Identity, id: ReadingListId) {
  return (await deps.users.deleteReadingList(user.id, id)) ? NO_CONTENT : fail(404, { code: "reading-list-not-found" });
}

export async function memberships(deps: { users: ReadingLists }, user: Identity, documentId: DocumentId) {
  return ok({ lists: await deps.users.readingListMemberships(user.id, documentId) });
}

export async function addDocument(
  deps: { users: ReadingLists; documents: DocumentLookup } & Clock,
  user: Identity,
  listId: ReadingListId,
  documentId: DocumentId,
) {
  const document = await deps.documents.visible(documentId, user.id);
  if (!document) return fail(404, { code: "document-not-found" });
  return (await deps.users.addDocumentToReadingList(user.id, listId, documentId, document.lang, timestamp(deps.now())))
    ? NO_CONTENT
    : fail(404, { code: "reading-list-not-found" });
}

export async function removeDocument(deps: { users: ReadingLists }, user: Identity, listId: ReadingListId, documentId: DocumentId) {
  // Removal remains possible after a document becomes unavailable.
  return (await deps.users.removeDocumentFromReadingList(user.id, listId, documentId))
    ? NO_CONTENT
    : fail(404, { code: "reading-list-not-found" });
}

export async function documents(
  deps: { users: ReadingLists; documents: DocumentLookup },
  user: Identity,
  id: ReadingListId,
  lang: Lang | undefined,
  page: PageRequest<ReadingKey>,
) {
  const found = await deps.users.readingListDocuments(user.id, id, lang, page);
  if (!found) return fail(404, { code: "reading-list-not-found" });
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
