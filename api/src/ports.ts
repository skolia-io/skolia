// What the API needs from its surroundings: D1, R2, the ingest Worker's workflow and a
// Durable Object per user (src/worker/adapters.ts), Better Auth (src/auth.ts), and fakes in the
// tests.
import type { Status } from "@skolia/shared/schema";
import type {
  Annotation,
  AnnotationFilter,
  AnnotationId,
  AnnotationKey,
  AvailableTag,
  CardCounts,
  CardGroup,
  Card,
  CardId,
  CardKey,
  CardListing,
  DocumentFilter,
  DocumentId,
  DocumentKey,
  Paginated,
  Tag,
  TagKey,
  Timestamp,
  UserId,
  Lang,
  LemmaId,
  Lookup,
  Licence,
  NewCard,
  NewLeft,
  ReadingListId,
  ReadingList,
  ReadingKey,
  Reviewed,
  ReviewRequest,
  ScheduledCard,
  Settings,
  User,
  Visibility,
  Tags,
  CardState,
  ContainerJobs,
  IngestHistory,
} from "@skolia/shared/api";
import type { PageRequest } from "@skolia/shared/page";
import type { Versions } from "@skolia/shared/schema";
import type * as schemas from "@skolia/shared/schemas";
import type * as z from "zod";

/** A text, stored once however many users import it, and never deleted. Its state lives in
 * the status blob. */
export interface DocumentContent {
  readonly id: DocumentId;
  readonly lang: Lang;
  readonly words: number;
}

/** What a user says about a text they imported. The licence is their claim. */
export interface EntryFields {
  readonly title: string;
  readonly visibility: Visibility;
  readonly licence: Licence;
  readonly author: string | null;
  readonly source: string | null;
  readonly tags: Tags;
}

/** A user's entry for a text they imported. */
export interface DocumentEntry extends EntryFields {
  readonly id: DocumentId;
  readonly user: UserId;
  readonly importedAt: Timestamp;
}

/** An entry with its text's language and word count, and its user's name. */
export interface StoredDocument extends DocumentEntry {
  readonly lang: Lang;
  readonly words: number;
  readonly importerName: string;
  readonly status: Status | null;
}

export interface DocumentLookup {
  /** A page of the public entries and the viewer's private ones, by user then text, that the
   * filter keeps (with mine, the viewer's alone). */
  list(viewer: UserId | null, filter: DocumentFilter, page: PageRequest<DocumentKey>): Promise<Paginated<StoredDocument, DocumentKey>>;
  /** The entry the viewer sees for a text: their own, else its earliest public one. Null
   * for a text that's unknown or private to others. */
  visible(id: DocumentId, viewer: UserId | null): Promise<StoredDocument | null>;
  /** visible's entry for each of the texts that has one. */
  visibleAll(ids: readonly DocumentId[], viewer: UserId | null): Promise<ReadonlyMap<DocumentId, StoredDocument>>;
}

export interface DocumentTags {
  /** A page of the tags that can be given, by kind, then in each kind's order. */
  tags(page: PageRequest<TagKey>): Promise<Paginated<AvailableTag, TagKey>>;
  /** Those of the tags that can be given. */
  known(tags: readonly Tag[]): Promise<readonly Tag[]>;
}

export interface DocumentStatusStore {
  /** Update the list projection when the status blob is published. */
  setStatus(id: DocumentId, status: Status): Promise<void>;
}

export interface DocumentEntries {
  /** Whether the text is stored, whoever imported it. */
  has(id: DocumentId): Promise<boolean>;
  /** Insert the entry, and the content unless it's already there. An existing entry is kept. */
  add(content: DocumentContent, entry: DocumentEntry): Promise<void>;
  /** Its tags replace all the entry had. */
  update(id: DocumentId, user: UserId, fields: EntryFields): Promise<void>;
  /** Delete the user's entry. The text stays, for anyone who imports it again. */
  remove(id: DocumentId, user: UserId): Promise<void>;
}

export interface DocumentAnnotations {
  /** A page of the user's entry's annotations that the filter keeps, by where they start. */
  annotations(
    id: DocumentId,
    user: UserId,
    filter: AnnotationFilter,
    page: PageRequest<AnnotationKey>,
  ): Promise<Paginated<Annotation, AnnotationKey>>;
  /** Add each annotation the user's entry hasn't one with the id of, in one transaction, until
   * it has MAX_ANNOTATIONS. At most ANNOTATION_BATCH. */
  annotate(id: DocumentId, user: UserId, annotations: readonly Annotation[]): Promise<AnnotateResult>;
  /** False if the user's entry has no annotation with the id. */
  unannotate(id: DocumentId, user: UserId, annotationId: AnnotationId): Promise<boolean>;
}

export interface DocumentStore extends DocumentLookup, DocumentTags, DocumentStatusStore, DocumentEntries, DocumentAnnotations {}

/** added: the entry has them all, as they're given here, added of them new. full: it filled
 * up before it had them all; those before stay. */
export type AnnotateResult =
  | { readonly kind: "added"; readonly added: number; readonly annotations: readonly Annotation[] }
  | { readonly kind: "full" };

export interface StoredBlob {
  body: Uint8Array<ArrayBuffer>;
  contentType: string | undefined;
}

export interface BlobStore {
  get(key: string): Promise<StoredBlob | null>;
  put(key: string, body: Uint8Array<ArrayBuffer> | string, contentType: string): Promise<void>;
}

/** A language's ingest container's jobs (analysis/src/skolia_analysis/ingest/http.py
 * JobsState) */
export type IngestJobs = ContainerJobs;

export interface JobQueue {
  /** Starts a run of ingest for the document, made to the versions ingest now publishes (null
   * before it has published any). One under way is left to finish; one that has ended is run
   * again. */
  start(doc: DocumentId, lang: Lang, versions: Versions | null): Promise<void>;
  /** Null when no container is running for the language, or it can't be asked. */
  jobs(lang: Lang): Promise<IngestJobs | null>;
}

export interface DueCards {
  readonly cards: ScheduledCard[];
  readonly newLeft: NewLeft;
}

/** out-of-order: answered before the card was made or before its last review.
 * id-reused: the review id is another card's. */
export type ReviewOutcome = ({ kind: "reviewed" } & Reviewed) | { kind: "no-card" } | { kind: "out-of-order" } | { kind: "id-reused" };

/** made: the card is new. had: the word had one of its kind, or the text had one at the
 * blank. full: the user has MAX_CARDS. */
export type CardOutcome = { readonly kind: "made" | "had"; readonly cardId: CardId } | { readonly kind: "full" };

/** now: the request's
 * time by the API's clock (Deps.now), which the tests set. dayStart: when the user's
 * day started in their time zone; today's new cards count from it. */
export interface UserCards {
  /** group: only its cards; undefined, both groups'. */
  due(userId: UserId, lang: Lang, now: Timestamp, dayStart: Timestamp, limit: number, group: CardGroup | undefined): Promise<DueCards>;
  counts(userId: UserId, now: Timestamp, dayStart: Timestamp): Promise<CardCounts[]>;
  review(userId: UserId, request: ReviewRequest, now: Timestamp): Promise<ReviewOutcome>;
  /** A new card, unless the word had one of its kind, or the text had one at the blank, or
   * the user has MAX_CARDS. */
  makeCard(userId: UserId, card: NewCard, now: Timestamp): Promise<CardOutcome>;
  /** A page of a language's or a word's cards, newest first, or of a text's, by where their blanks start. */
  cards(userId: UserId, listing: CardListing): Promise<Paginated<Card, CardKey>>;
  /** False if the user has no such card. */
  setCardState(userId: UserId, cardId: CardId, state: CardState): Promise<boolean>;
  /** Deletes the card and its reviews. False if the user has no such card. */
  deleteCard(userId: UserId, cardId: CardId): Promise<boolean>;
}

export interface UserSettings {
  settings(userId: UserId): Promise<Settings>;
  setSettings(userId: UserId, settings: Settings): Promise<void>;
}

export interface ReadingPositions {
  position(userId: UserId, documentId: DocumentId): Promise<StoredPosition | null>;
  /** Keeps the stored position if it's as new as this one or newer. */
  setPosition(userId: UserId, documentId: DocumentId, position: StoredPosition): Promise<void>;
}

export interface ReadingLists {
  readingLists(userId: UserId): Promise<readonly ReadingList[]>;
  createReadingList(userId: UserId, name: string, now: Timestamp): Promise<ReadingListId | null>;
  renameReadingList(userId: UserId, id: ReadingListId, name: string): Promise<boolean>;
  deleteReadingList(userId: UserId, id: ReadingListId): Promise<boolean>;
  readingListMemberships(userId: UserId, documentId: DocumentId): Promise<readonly ReadingListId[]>;
  addDocumentToReadingList(
    userId: UserId,
    listId: ReadingListId,
    documentId: DocumentId,
    lang: Lang,
    createdAt: Timestamp,
  ): Promise<boolean>;
  removeDocumentFromReadingList(userId: UserId, listId: ReadingListId, documentId: DocumentId): Promise<boolean>;
  readingListDocuments(
    userId: UserId,
    id: ReadingListId,
    lang: Lang | undefined,
    page: PageRequest<ReadingKey>,
  ): Promise<Paginated<{ readonly documentId: DocumentId; readonly createdAt: Timestamp }, ReadingKey> | null>;
}

/** Data stored in a Durable Object per user. */
export interface UserData extends UserCards, UserSettings, ReadingPositions, ReadingLists {}

export type StoredPosition = z.output<typeof schemas.StoredPosition>;

/** The lexicon, with the feature sets its entries' paradigms use. Ids it doesn't have are left out. */
export interface Lexicon {
  entries(ids: readonly LemmaId[]): Promise<Lookup>;
}

export interface Auth {
  handle(request: Request): Promise<Response>;
  user(headers: Headers): Promise<User | null>;
}

export interface Deps {
  auth: Auth;
  users: UserData;
  lexicon: Lexicon;
  documents: DocumentStore;
  blobs: BlobStore;
  queue: JobQueue;
  ingestHistory: IngestHistory;
  /** git describe of the build */
  version: string;
  now: () => Date;
  /** For the tests: a response its route's spec doesn't describe is a 500 (openapi.ts). */
  checkResponses?: boolean;
}
