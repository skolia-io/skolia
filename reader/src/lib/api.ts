// skolia-api client, typed by the API's routes (AppType), and the lexicon's, typed by its
// own (lexicon/src/app.ts), which the API passes through at /api/lexicon/. The analysis
// and bundle are blobs the API passes through, typed by the Python schemas
// (shared/schema.gen.ts); the API is ours, so they're trusted to match.
import { hc } from "hono/client";
import type { AppType } from "@skolia/api/app";
import type { AppType as LexiconApp, EntriesBody } from "@skolia/lexicon/app";
import {
  ANNOTATION_PAGE,
  type Annotation,
  CARD_PAGE,
  TAG_PAGE,
  isLang,
  lemmaParam,
  type AnnotationKey,
  type ApiError,
  type Card,
  type CardCounts,
  type CardGroup,
  type CardId,
  type CardKey,
  type CardMade,
  type CardState,
  type DocumentId,
  type DocumentKey,
  type TagKey,
  type Paginated,
  type Due,
  type DocumentSummary,
  type AvailableTag,
  type DocumentUpdate,
  type ImportRequest,
  type IngestOverview,
  type Lang,
  type LemmaId,
  type NewCardInput,
  type Rating,
  type ReadingListId,
  type ReadingList,
  type ReadingListDocument,
  type ReadingKey,
  type ReadingPosition,
  type ReadingNames,
  type Reviewed,
  type Settings,
  type User,
} from "@skolia/shared/api";
import { allPages, type Cursor } from "@skolia/shared/page";
import { BUNDLE_SCHEMA, SCHEMA, type Blob, type Bundle } from "@skolia/shared/schema";

const api = hc<AppType>("/").api;
const lexicon = hc<LexiconApp>("/api/lexicon").v1;

export interface Reading {
  lang: Lang;
  text: string;
  analysis: Blob;
  bundle: Bundle;
}

async function failure(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as ApiError | null;
  return new Error(body?.error ?? `${response.status} ${response.statusText}`);
}

export async function currentUser(): Promise<User | null> {
  const response = await api.me.$get();
  if (response.status === 401) return null;
  if (!response.ok) throw await failure(response);
  return response.json();
}

async function auth(path: string, body: unknown): Promise<Response> {
  const response = await fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await failure(response);
  return response;
}

export async function signIn(): Promise<void> {
  const response = await auth("sign-in/social", { provider: "google", callbackURL: location.href });
  const { url } = (await response.json()) as { url: string };
  location.assign(url);
}

export async function signOut(): Promise<void> {
  await auth("sign-out", {});
}

/** A 401 on a page of a list of the user's, for listOwn. */
class SignedOut extends Error {}

/** Every page of a list of the signed-in user's, or null when signed out. */
async function listOwn<T, K>(fetchPage: (after: Cursor<K> | undefined) => Promise<Paginated<T, K>>): Promise<readonly T[] | null> {
  try {
    return await allPages(fetchPage);
  } catch (error) {
    if (error instanceof SignedOut) return null;
    throw error;
  }
}

/** Which documents Explore lists. tags: kind:value, any of one kind, all of the kinds. */
export type DocumentQuery = {
  readonly lang: Lang | undefined;
  readonly title: string;
  readonly mine: boolean;
  readonly tags: readonly string[];
};

/** A page of the documents the query keeps, from the start or after a page's next. */
export async function listDocuments(
  { lang, title, mine, tags }: DocumentQuery,
  after?: Cursor<DocumentKey>,
): Promise<Paginated<DocumentSummary, DocumentKey>> {
  const response = await api.documents.$get({
    query: { after, lang, q: title.trim() || undefined, mine: mine ? "true" : undefined, tag: [...tags] },
  });
  if (!response.ok) throw await failure(response);
  return response.json();
}

/** The deployed version, which the build doesn't know (api/src/worker/main.ts VERSION). */
export async function getVersion(): Promise<string> {
  const response = await api.version.$get();
  if (!response.ok) throw await failure(response);
  return (await response.json()).version;
}

/** The tags that can be given. */
export function listTags(): Promise<readonly AvailableTag[]> {
  return allPages(async (after?: Cursor<TagKey>) => {
    const response = await api.tags.$get({ query: { after, limit: String(TAG_PAGE.max) } });
    if (!response.ok) throw await failure(response);
    return response.json();
  });
}

export async function getDocument(id: DocumentId): Promise<DocumentSummary> {
  const response = await api.documents[":id"].$get({ param: { id } });
  if (!response.ok) throw await failure(response);
  return response.json();
}

/** What analysis is doing: each language's analyser and the jobs finished most recently. */
export async function getIngest(): Promise<IngestOverview> {
  const response = await api.ingest.$get();
  if (!response.ok) throw await failure(response);
  return response.json();
}

/** The text as uploaded, to show before its analysis is ready. */
export async function getText(id: DocumentId): Promise<string> {
  const response = await api.documents[":id"].text.$get({ param: { id } });
  if (!response.ok) throw await failure(response);
  return response.text();
}

export async function importDocument(body: ImportRequest): Promise<DocumentSummary> {
  const response = await api.documents.$post({ json: body });
  if (!response.ok) throw await failure(response);
  return response.json();
}

export async function updateDocument(id: DocumentId, update: DocumentUpdate): Promise<DocumentSummary> {
  const response = await api.documents[":id"].$patch({ param: { id }, json: update });
  if (!response.ok) throw await failure(response);
  return response.json();
}

export async function deleteDocument(id: DocumentId): Promise<void> {
  const response = await api.documents[":id"].$delete({ param: { id } });
  if (!response.ok) throw await failure(response);
}

/** Every annotation of the entry the viewer sees for the text. */
export function listAnnotations(id: DocumentId): Promise<readonly Annotation[]> {
  return allPages(async (after?: Cursor<AnnotationKey>) => {
    const response = await api.documents[":id"].annotations.$get({
      param: { id },
      query: { after, limit: String(ANNOTATION_PAGE.max) },
    });
    if (!response.ok) throw await failure(response);
    return response.json();
  });
}

/** The reading by name, or "unsupported" when its analysis schema is newer than this
 * reader knows (an API deployed ahead of the reader), its bundle isn't this reader's
 * schema, or its language isn't one it has. An older bundle is redone when the document
 * is opened (BUNDLER_VERSION), and the text shows as plain text until then. */
export async function loadReading(id: DocumentId, names: ReadingNames): Promise<Reading | "unsupported"> {
  const doc = api.documents[":id"];
  const [text, analysis, bundle] = await Promise.all([
    doc.text.$get({ param: { id } }),
    doc.analysis[":name"].$get({ param: { id, name: names.analysis } }),
    doc.bundle[":name"].$get({ param: { id, name: names.bundle } }),
  ]);
  for (const response of [text, analysis, bundle]) if (!response.ok) throw await failure(response);
  const [a, b] = [(await analysis.json()) as Blob, (await bundle.json()) as Bundle];
  const lang = a.lang;
  if (a.schema > SCHEMA || b.schema !== BUNDLE_SCHEMA || !isLang(lang) || b.lang !== lang) return "unsupported";
  return { lang, text: await text.text(), analysis: a, bundle: b };
}

/** The start of the local day, which today's new cards count from. */
function dayStartOf(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/** Each language's cards due and new today. */
export async function cardCounts(now = new Date()): Promise<CardCounts[] | null> {
  const response = await api.me.cards.counts.$get({ query: { dayStart: dayStartOf(now) } });
  if (response.status === 401) return null;
  if (!response.ok) throw await failure(response);
  return response.json();
}

/** A language's cards to review: one group's, or with no group both. */
export async function dueCards(lang: Lang, group: CardGroup | null, now = new Date()): Promise<Due | null> {
  const dayStart = dayStartOf(now);
  const response = await api.me.cards.due.$get({ query: group ? { lang, dayStart, group } : { lang, dayStart } });
  if (response.status === 401) return null;
  if (!response.ok) throw await failure(response);
  // Hono's JSON type makes the entries' optional fields `| undefined`, which
  // exactOptionalPropertyTypes tells apart; it's the same JSON
  return (await response.json()) as Due;
}

export async function review(cardId: string, rating: Rating): Promise<Reviewed> {
  const json = { id: crypto.randomUUID(), cardId, rating, at: new Date().toISOString() };
  const response = await api.me.reviews.$post({ json });
  if (!response.ok) throw await failure(response);
  return response.json();
}

/** A card, or the one there was: the word's of its kind, or the sentence's at the blank. */
export async function makeCard(card: NewCardInput): Promise<CardMade> {
  const response = await api.me.cards.$post({ json: card });
  if (!response.ok) throw await failure(response);
  return response.json();
}

/** The user's cards from a text, by where their blanks start, or null when signed out. */
export function listTextCards(documentId: DocumentId): Promise<readonly Card[] | null> {
  return listOwn(async (after?: Cursor<CardKey>) => {
    const response = await api.me.cards.$get({ query: { documentId, after, limit: String(CARD_PAGE.max) } });
    if (response.status === 401) throw new SignedOut();
    if (!response.ok) throw await failure(response);
    return response.json();
  });
}

/** A word's cards, or null when signed out. */
export function listWordCards(lemmaId: LemmaId): Promise<readonly Card[] | null> {
  return listOwn(async (after?: Cursor<CardKey>) => {
    const response = await api.me.cards.$get({ query: { lemmaId, after, limit: String(CARD_PAGE.max) } });
    if (response.status === 401) throw new SignedOut();
    if (!response.ok) throw await failure(response);
    return response.json();
  });
}

/** A page of a language's cards, newest first. */
export async function listCards(lang: Lang, after?: Cursor<CardKey>): Promise<Paginated<Card, CardKey>> {
  const response = await api.me.cards.$get({ query: { lang, after } });
  if (!response.ok) throw await failure(response);
  return response.json();
}

export async function setCardState(cardId: CardId, state: CardState): Promise<void> {
  const response = await api.me.cards[":cardId"].$patch({ param: { cardId }, json: { state } });
  if (!response.ok) throw await failure(response);
}

/** Deletes a card of any kind, with its reviews. */
export async function deleteCard(cardId: CardId): Promise<void> {
  const response = await api.me.cards[":cardId"].$delete({ param: { cardId } });
  if (!response.ok) throw await failure(response);
}

export async function lexiconVersion(lang: Lang): Promise<string | null> {
  const response = await lexicon.lexicons[":lang"].$get({ param: { lang } }, { init: { cache: "no-store", credentials: "omit" } });
  if (!response.ok) throw await failure(response);
  return (await response.json()).version;
}

export class LexiconVersionChanged extends Error {}

export async function lookUp(id: LemmaId, version: string): Promise<EntriesBody | null> {
  const response: Response = await lexicon.entries[":id"].$get(
    { param: { id: lemmaParam(id) }, query: { version } },
    { init: { credentials: "omit" } },
  );
  if (response.status === 404) return null;
  if (response.status === 409) throw new LexiconVersionChanged("The lexicon changed during lookup");
  if (!response.ok) throw await failure(response);
  // Hono's JSON type makes the entries' optional fields `| undefined`.
  return (await response.json()) as EntriesBody;
}

export async function getSettings(): Promise<Settings> {
  const response = await api.me.settings.$get();
  if (!response.ok) throw await failure(response);
  return response.json();
}

export async function saveSettings(settings: Settings): Promise<void> {
  const response = await api.me.settings.$put({ json: settings });
  if (!response.ok) throw await failure(response);
}

/** Where the user was in the text, null if nowhere yet, or undefined when signed out. */
export async function getPosition(id: DocumentId): Promise<ReadingPosition | null | undefined> {
  const response = await api.me.positions[":id"].$get({ param: { id } });
  if (response.status === 401) return undefined;
  if (!response.ok) throw await failure(response);
  return (await response.json()).position;
}

export async function readingLists(): Promise<readonly ReadingList[]> {
  const response = await api.me["reading-lists"].$get();
  if (!response.ok) throw await failure(response);
  return (await response.json()).lists;
}
export async function createReadingList(name: string): Promise<ReadingListId> {
  const response = await api.me["reading-lists"].$post({ json: { name } });
  if (!response.ok) throw await failure(response);
  return (await response.json()).id;
}
export async function renameReadingList(listId: ReadingListId, name: string): Promise<void> {
  const response = await api.me["reading-lists"][":listId"].$patch({ param: { listId: String(listId) }, json: { name } });
  if (!response.ok) throw await failure(response);
}
export async function deleteReadingList(listId: ReadingListId): Promise<void> {
  const response = await api.me["reading-lists"][":listId"].$delete({ param: { listId: String(listId) } });
  if (!response.ok) throw await failure(response);
}
export async function readingListMemberships(id: DocumentId): Promise<readonly ReadingListId[]> {
  const response = await api.me["reading-list-memberships"][":id"].$get({ param: { id } });
  if (!response.ok) throw await failure(response);
  return (await response.json()).lists;
}
export async function addDocumentToReadingList(listId: ReadingListId, id: DocumentId): Promise<void> {
  const response = await api.me["reading-lists"][":listId"].documents[":id"].$put({ param: { listId: String(listId), id } });
  if (!response.ok) throw await failure(response);
}
export async function removeDocumentFromReadingList(listId: ReadingListId, id: DocumentId): Promise<void> {
  const response = await api.me["reading-lists"][":listId"].documents[":id"].$delete({ param: { listId: String(listId), id } });
  if (!response.ok) throw await failure(response);
}
export async function readingListDocuments(
  listId: ReadingListId,
  lang: Lang | undefined,
  after?: Cursor<ReadingKey>,
): Promise<Paginated<ReadingListDocument, ReadingKey>> {
  const response = await api.me["reading-lists"][":listId"].documents.$get({
    param: { listId: String(listId) },
    query: { after, ...(lang ? { lang } : {}) },
  });
  if (!response.ok) throw await failure(response);
  return response.json();
}

/** keepalive: the request outlives the page, for a save as it's hidden or closed. */
export async function putPosition(id: DocumentId, position: ReadingPosition, keepalive = false): Promise<void> {
  const response = await api.me.positions[":id"].$put({ param: { id }, json: position }, { init: { keepalive } });
  if (!response.ok) throw await failure(response);
}
