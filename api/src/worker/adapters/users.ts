import type {
  CardCounts,
  CardGroup,
  Card,
  CardId,
  CardKey,
  CardListing,
  NewCard,
  Paginated,
  DocumentId,
  Lang,
  Timestamp,
  UserId,
  ReadingListId,
  ReadingList,
  ReadingKey,
  ReviewRequest,
  Settings,
  CardState,
} from "@skolia/shared/api";
import type { PageRequest } from "@skolia/shared/page";
import type {
  CardOutcome,
  DueCards,
  ReviewOutcome,
  StoredPosition,
  ReadingLists,
  ReadingPositions,
  UserCards,
  UserSettings,
} from "../../ports/users.ts";
import type { User } from "../user.ts";

export class DurableObjectUsers implements UserCards, UserSettings, ReadingPositions, ReadingLists {
  private readonly users: DurableObjectNamespace<User>;

  constructor(users: DurableObjectNamespace<User>) {
    this.users = users;
  }

  async due(
    userId: UserId,
    lang: Lang,
    now: Timestamp,
    dayStart: Timestamp,
    limit: number,
    group: CardGroup | undefined,
  ): Promise<DueCards> {
    return this.users.getByName(userId).due(lang, now, dayStart, limit, group);
  }

  async counts(userId: UserId, now: Timestamp, dayStart: Timestamp): Promise<CardCounts[]> {
    return this.users.getByName(userId).counts(now, dayStart);
  }

  async review(userId: UserId, request: ReviewRequest, now: Timestamp): Promise<ReviewOutcome> {
    return this.users.getByName(userId).review(request, now);
  }

  async makeCard(userId: UserId, card: NewCard, now: Timestamp): Promise<CardOutcome> {
    return this.users.getByName(userId).makeCard(card, now);
  }

  async cards(userId: UserId, listing: CardListing): Promise<Paginated<Card, CardKey>> {
    return this.users.getByName(userId).cards(listing);
  }

  async setCardState(userId: UserId, cardId: CardId, state: CardState): Promise<boolean> {
    return this.users.getByName(userId).setCardState(cardId, state);
  }

  async deleteCard(userId: UserId, cardId: CardId): Promise<boolean> {
    return this.users.getByName(userId).deleteCard(cardId);
  }

  async settings(userId: UserId): Promise<Settings> {
    return this.users.getByName(userId).settings();
  }

  async setSettings(userId: UserId, settings: Settings): Promise<void> {
    await this.users.getByName(userId).setSettings(settings);
  }

  async position(userId: UserId, documentId: DocumentId): Promise<StoredPosition | null> {
    return this.users.getByName(userId).position(documentId);
  }

  async setPosition(userId: UserId, documentId: DocumentId, position: StoredPosition): Promise<void> {
    await this.users.getByName(userId).setPosition(documentId, position);
  }

  async readingLists(userId: UserId): Promise<readonly ReadingList[]> {
    return this.users.getByName(userId).readingLists();
  }
  async createReadingList(userId: UserId, name: string, now: Timestamp): Promise<ReadingListId | null> {
    return this.users.getByName(userId).createReadingList(name, now);
  }
  async renameReadingList(userId: UserId, id: ReadingListId, name: string): Promise<boolean> {
    return this.users.getByName(userId).renameReadingList(id, name);
  }
  async deleteReadingList(userId: UserId, id: ReadingListId): Promise<boolean> {
    return this.users.getByName(userId).deleteReadingList(id);
  }
  async readingListMemberships(userId: UserId, documentId: DocumentId): Promise<readonly ReadingListId[]> {
    return this.users.getByName(userId).readingListMemberships(documentId);
  }
  async addDocumentToReadingList(
    userId: UserId,
    listId: ReadingListId,
    documentId: DocumentId,
    lang: Lang,
    createdAt: Timestamp,
  ): Promise<boolean> {
    return this.users.getByName(userId).addDocumentToReadingList(listId, documentId, lang, createdAt);
  }
  async removeDocumentFromReadingList(userId: UserId, listId: ReadingListId, documentId: DocumentId): Promise<boolean> {
    return this.users.getByName(userId).removeDocumentFromReadingList(listId, documentId);
  }
  async readingListDocuments(userId: UserId, id: ReadingListId, lang: Lang | undefined, page: PageRequest<ReadingKey>) {
    return this.users.getByName(userId).readingListDocuments(id, lang, page);
  }
}
