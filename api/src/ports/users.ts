import type {
  CardCounts,
  Card,
  CardId,
  CardKey,
  CardListing,
  DocumentId,
  Paginated,
  Timestamp,
  UserId,
  Lang,
  NewCard,
  ReadingListId,
  ReadingList,
  ReadingKey,
  Reviewed,
  ReviewRequest,
  ScheduledCard,
  Settings,
  LemmaId,
  Word,
  WordState,
} from "@skolia/shared/api";
import type { PageRequest } from "@skolia/shared/page";
import type * as schemas from "@skolia/shared/schemas";
import type * as z from "zod";
import type { RateLimit } from "../rate-limits.ts";

export interface DueCards {
  readonly cards: ScheduledCard[];
  /** New words left of today's allowance. */
  readonly newLeft: number;
}

/** out-of-order: answered before the card was made or before its last review.
 * id-reused: the review id is another card's. */
export type ReviewOutcome = ({ kind: "reviewed" } & Reviewed) | { kind: "no-card" } | { kind: "out-of-order" } | { kind: "id-reused" };

/** made: the card is new. had: the word had one of its kind, or the text had one at the
 * blank. full: the user has MAX_CARDS. */
export type CardOutcome = { readonly kind: "made" | "had"; readonly cardId: CardId } | { readonly kind: "full" };

/** now: the request's time from the API's Clock. dayStart: when the user's day started in
 * their time zone, which is when today's new cards start counting. */
export interface UserCards {
  due(userId: UserId, lang: Lang, now: Timestamp, dayStart: Timestamp, limit: number): Promise<DueCards>;
  counts(userId: UserId, now: Timestamp, dayStart: Timestamp): Promise<CardCounts[]>;
  review(userId: UserId, request: ReviewRequest, now: Timestamp): Promise<ReviewOutcome>;
  /** A new card, unless the word had one of its kind, or the text had one at the blank, or
   * the user has MAX_CARDS. */
  makeCard(userId: UserId, card: NewCard, now: Timestamp): Promise<CardOutcome>;
  /** A page of a language's or a word's cards, newest first, or of a text's, by where their blanks start. */
  cards(userId: UserId, listing: CardListing): Promise<Paginated<Card, CardKey>>;
  /** Those of the words the user has, with their states, in no set order. */
  words(userId: UserId, lemmaIds: readonly LemmaId[]): Promise<readonly Word[]>;
  /** False if the user hasn't the word. */
  setWordState(userId: UserId, lemmaId: LemmaId, state: WordState): Promise<boolean>;
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

/** What's rate-limited per user (rate-limits.ts). */
export type RateAction = "import";

/** taken: counted in the window. limited: the window has its limit; the next starts in
 * retryAfterSeconds. */
export type RateOutcome = { readonly kind: "taken" } | { readonly kind: "limited"; readonly retryAfterSeconds: number };

export interface UserRateLimits {
  /** Counts the action once more in the user's current window, unless it has the limit already. */
  take(userId: UserId, action: RateAction, now: Timestamp, limit: RateLimit): Promise<RateOutcome>;
}

/** Data stored in a Durable Object per user. */
export interface UserData extends UserCards, UserSettings, ReadingPositions, ReadingLists, UserRateLimits {}

export type StoredPosition = z.output<typeof schemas.StoredPosition>;
