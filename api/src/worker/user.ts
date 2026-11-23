import { DurableObject } from "cloudflare:workers";
import {
  LANGS,
  MAX_CARDS,
  parseLemmaId,
  timestamp,
  type CardCounts,
  type CardId as CardIdType,
  type LemmaId,
  type Card,
  type WordState,
  type CardKey,
  type CardListing,
  type DocumentId,
  type Paginated,
  type ReadingListId,
  type ReadingList,
  type ReadingKey,
  type NewCard,
  type Timestamp,
  type Lang,
  type ReviewRequest,
  type ScheduledCard,
  type Settings,
} from "@skolia/shared/api";
import { paginate, type PageRequest } from "@skolia/shared/page";
import * as schemas from "@skolia/shared/schemas";
import { CardId } from "@skolia/shared/schemas";
import { compile, insertInto, type Query } from "@skolia/util/query";
import { sql, type Sql } from "@skolia/util/sql";
import { OPTIMIZE } from "@skolia/util/sqlite";
import type { CardOutcome, DueCards, RateAction, RateOutcome, ReviewOutcome, StoredPosition } from "../ports/users.ts";
import type { RateLimit } from "../rate-limits.ts";
import { fromJson, fsrs, newCard, review, toJson } from "./scheduler.ts";
import { MIGRATIONS } from "../user/migrations/index.ts";
import {
  BLANK_DOCUMENT,
  BLANK_START,
  cardsQuery,
  dueCountQuery,
  dueQuery,
  freshCountQuery,
  freshQuery,
  readingListDocumentsQuery,
  startQuery,
  startedSinceQuery,
  wordCardQuery,
} from "../user/queries.ts";
import {
  LogEntry,
  MigrationError,
  applied,
  plan,
  problems,
  revertEdited,
  withChecksums,
  type Checksummed,
  type Step,
} from "../user/migrator.ts";

export interface MigrationStatus {
  version: number | null;
  log: LogEntry[];
  problems: string[];
}

let checksummed: Promise<Checksummed[]> | undefined;

/** A row of due()'s queries. */
function scheduled(row: Record<string, SqlStorageValue>): ScheduledCard {
  const { id, kind, dueAt, data } = row;
  return schemas.ScheduledCard.parse({
    id,
    lemmaIds: JSON.parse(String(row["lemmaIds"])),
    kind,
    dueAt,
    isNew: row["isNew"] === 1,
    data: JSON.parse(String(data)),
  });
}

/** The card a new one would repeat: the word's of its kind (card_word_kind), or the text's
 * cloze card at the blank (card_blank). */
function existingCard(card: NewCard): Sql {
  switch (card.kind) {
    case "recognition":
    case "production":
      return wordCardQuery(card.lemmaId, card.kind);
    case "cloze":
      return sql`SELECT id FROM card WHERE kind = 'cloze' AND ${BLANK_DOCUMENT} = ${card.data.documentId} AND ${BLANK_START} = ${card.data.blankStart}`;
  }
}

/** A row of cardsQuery. */
function listed(row: Record<string, SqlStorageValue>): Card {
  const { id, kind, createdAt, scheduleStatus, dueAt, scheduledDays, lastReviewedAt } = row;
  return schemas.Card.parse({
    id,
    lemmaIds: JSON.parse(String(row["lemmaIds"])),
    kind,
    createdAt,
    state: Number(row["learningWords"]) > 0 ? "learning" : "known",
    scheduleStatus,
    dueAt,
    scheduledDays,
    lastReviewedAt,
    data: JSON.parse(String(row["data"])),
  });
}

/** What optimize() read and wrote, as Durable Objects bill them */
export type Optimized = {
  readonly rowsRead: number;
  readonly rowsWritten: number;
};

export interface UserEnv {
  /** "true" on previews and locally. For this object's migrations (user/migrations) only, not D1's: an edited
   * last migration is reverted with the down it was applied with, and applied again. */
  MUTABLE_FINAL_USER_MIGRATION?: string;
}

export class User extends DurableObject<UserEnv> {
  constructor(ctx: DurableObjectState, env: UserEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => this.#migrate(MIGRATIONS.length));
  }

  #exec(query: Query | Sql): SqlStorageCursor<Record<string, SqlStorageValue>> {
    const { text, params } = compile(query);
    return this.ctx.storage.sql.exec(text, ...params);
  }

  migrate(version: number): Promise<void> {
    return this.ctx.blockConcurrencyWhile(() => this.#migrate(version));
  }

  /** Brings the query planner's statistics up to date (OPTIMIZE). The object runs it when it
   * starts, after migrating, and after any migrate(): it lives while it's in use and is evicted
   * once idle, so each start is a new connection. */
  optimize(): Optimized {
    const cursor = this.#exec(OPTIMIZE);
    cursor.toArray();
    return { rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten };
  }

  async migrationStatus(): Promise<MigrationStatus> {
    const migrations = await (checksummed ??= withChecksums(MIGRATIONS));
    const log = this.#log();
    try {
      const stack = applied(log);
      const { kept } = await this.#revertEdited(stack, migrations);
      return { version: stack.length, log, problems: problems(kept, migrations) };
    } catch (error) {
      if (!(error instanceof MigrationError)) throw error;
      return { version: null, log, problems: [error.message] };
    }
  }

  /** A new card, or the one there was (existingCard). Past MAX_CARDS, a new card is refused.
   * The card belongs to its word, added now, learning, if the user hadn't it. */
  async makeCard(card: NewCard, now: Timestamp): Promise<CardOutcome> {
    const s = await fsrs();
    const id = CardId.parse(crypto.randomUUID());
    const fresh = toJson(newCard(s, id, new Date(now)));
    return this.ctx.storage.transactionSync((): CardOutcome => {
      const had = this.#exec(existingCard(card)).toArray()[0];
      if (had !== undefined) return { kind: "had", cardId: CardId.parse(had["id"]) };
      if (Number(this.#exec(sql`SELECT n FROM row_count WHERE name = 'card'`).one()["n"]) >= MAX_CARDS) return { kind: "full" };
      this.#exec(insertInto("word").values({ lemma_id: card.lemmaId, added_at: now, state: "learning" }).onConflict(["lemma_id"]));
      this.#exec(
        insertInto("card").values({
          id,
          lang: parseLemmaId(card.lemmaId).lang,
          kind: card.kind,
          created_at: now,
          fsrs: fresh,
          data: JSON.stringify(card.data),
        }),
      );
      this.#exec(insertInto("card_word").values({ card_id: id, lemma_id: card.lemmaId, kind: card.kind, created_at: now }));
      return { kind: "made", cardId: id };
    });
  }

  /** Learning puts the word's cards in reviews, where each is in its schedule; known takes
   * out those whose words are all known (word_state_counted). Whether the user has the word. */
  setWordState(lemmaId: LemmaId, state: WordState): boolean {
    return this.#exec(sql`UPDATE word SET state = ${state} WHERE lemma_id = ${lemmaId} RETURNING lemma_id`).toArray().length > 0;
  }

  /** A page of a language's or a word's cards, newest first, or of a text's, by where their blanks start in it. */
  cards(listing: CardListing): Paginated<Card, CardKey> {
    const cards = this.#exec(cardsQuery(listing)).toArray().map(listed);
    const keyed = cards.map((item) => ({
      item,
      key: "documentId" in listing ? ([item.kind === "cloze" ? item.data.blankStart : 0] as const) : ([item.createdAt, item.id] as const),
    }));
    return paginate<Card, CardKey>(keyed, listing.limit);
  }

  /** Deletes a card of any kind, and by the foreign keys its reviews and its links to its
   * words, which stay. Whether there was one. */
  deleteCard(cardId: CardIdType): boolean {
    return this.#exec(sql`DELETE FROM card WHERE id = ${cardId}`).rowsWritten > 0;
  }

  /** How many new words a language has left of today's allowance, the daily limit being per
   * language: a word counts against the day it was started, the server's time of the first
   * answer to one of its cards, from dayStart. */
  #newLeft(lang: Lang, dayStart: Timestamp): number {
    const started = this.#exec(startedSinceQuery(lang, dayStart)).one()["n"];
    return Math.max(0, this.settings().newLemmasPerDay - Number(started));
  }

  /** A language's cards due by now, soonest first, then its new cards: those whose words are
   * all started, and those of as many words not yet started as are left of the day's
   * allowance, in the order they were made. */
  due(lang: Lang, now: Timestamp, dayStart: Timestamp, limit: number): DueCards {
    const newLeft = this.#newLeft(lang, dayStart);
    const dueNow = this.#exec(dueQuery(lang, now, limit)).toArray();
    const fresh = this.#exec(freshQuery(lang, newLeft, limit)).toArray();
    return { cards: [...dueNow, ...fresh].slice(0, limit).map(scheduled), newLeft };
  }

  /** For languages with words, how many cards are due, and how many new ones would come up today. */
  counts(now: Timestamp, dayStart: Timestamp): CardCounts[] {
    const languages = LANGS.filter((lang) => this.#exec(sql`SELECT 1 FROM word WHERE lang = ${lang} LIMIT 1`).toArray().length > 0);
    return languages.map((lang) => ({
      lang,
      due: Number(this.#exec(dueCountQuery(lang, now)).one()["n"]),
      new: Number(this.#exec(freshCountQuery(lang, this.#newLeft(lang, dayStart))).one()["n"]),
    }));
  }

  /** Once per review id: a retry gets the card as it is. A review starts the card's words not
   * yet started, at now, the server's time, which the daily allowance counts by, whatever the
   * client says. */
  async review({ id, cardId, rating, at }: ReviewRequest, now: Timestamp): Promise<ReviewOutcome> {
    const s = await fsrs();
    return this.ctx.storage.transactionSync((): ReviewOutcome => {
      const row = this.#exec(sql`SELECT fsrs, created_at FROM card WHERE id = ${cardId}`).toArray()[0];
      if (row === undefined) return { kind: "no-card" };
      const card = fromJson(String(row["fsrs"]));
      const seen = this.#exec(sql`SELECT card_id FROM review WHERE id = ${id}`).toArray()[0];
      if (seen !== undefined) {
        return seen["card_id"] === cardId ? { kind: "reviewed", cardId, dueAt: timestamp(card.dueAt) } : { kind: "id-reused" };
      }
      const when = new Date(at);
      if (when < new Date(String(row["created_at"])) || (card.lastReviewAt !== null && when < card.lastReviewAt)) {
        return { kind: "out-of-order" };
      }
      const next = review(s, card, rating, when);
      this.#exec(sql`INSERT INTO review (id, card_id, rating, reviewed_at) VALUES ${sql.tuple([id, cardId, rating, when.toISOString()])}`);
      this.#exec(sql`UPDATE card SET fsrs = ${toJson(next)} WHERE id = ${cardId}`);
      this.#exec(startQuery(cardId, now));
      return { kind: "reviewed", cardId, dueAt: timestamp(next.dueAt) };
    });
  }

  settings(): Settings {
    return schemas.Settings.parse(this.#exec(sql`SELECT new_lemmas_per_day AS "newLemmasPerDay" FROM settings WHERE id = 1`).one());
  }

  setSettings({ newLemmasPerDay }: Settings): void {
    this.#exec(sql`UPDATE settings SET new_lemmas_per_day = ${newLemmasPerDay} WHERE id = 1`);
  }

  position(documentId: DocumentId): StoredPosition | null {
    const row = this.#exec(sql`SELECT sentence, token, at FROM reading_position WHERE document_id = ${documentId}`).toArray()[0];
    return row === undefined
      ? null
      : { sentence: Number(row["sentence"]), token: Number(row["token"]), at: schemas.Timestamp.parse(row["at"]) };
  }

  setPosition(documentId: DocumentId, { sentence, token, at }: StoredPosition): void {
    this.#exec(
      sql`INSERT INTO reading_position (document_id, sentence, token, at) VALUES ${sql.tuple([documentId, sentence, token, at])}
       ON CONFLICT (document_id) DO UPDATE SET sentence = excluded.sentence, token = excluded.token, at = excluded.at
       WHERE excluded.at > reading_position.at`,
    );
  }

  readingLists(): readonly ReadingList[] {
    return this.#exec(
      sql`SELECT id, name, documents_count AS documentsCount, created_at AS createdAt FROM reading_list WHERE id > 0 ORDER BY id LIMIT 200`,
    )
      .toArray()
      .map((row) => schemas.ReadingList.parse(row));
  }

  createReadingList(name: string, now: Timestamp): ReadingListId | null {
    const row = this.#exec(sql`INSERT INTO reading_list (name, created_at)
      SELECT ${name}, ${now} WHERE (SELECT total FROM reading_list_count WHERE id = 1) < 200
      RETURNING id`).toArray()[0];
    return row ? schemas.ReadingListId.parse(row["id"]) : null;
  }

  renameReadingList(id: ReadingListId, name: string): boolean {
    return this.#exec(sql`UPDATE reading_list SET name = ${name} WHERE id = ${id} RETURNING id`).toArray().length > 0;
  }

  deleteReadingList(id: ReadingListId): boolean {
    return this.#exec(sql`DELETE FROM reading_list WHERE id = ${id} RETURNING id`).toArray().length > 0;
  }

  readingListMemberships(documentId: DocumentId): readonly ReadingListId[] {
    return this.#exec(sql`SELECT list_id FROM reading_list_document WHERE document_id = ${documentId} ORDER BY list_id LIMIT 200`)
      .toArray()
      .map((row) => schemas.ReadingListId.parse(row["list_id"]));
  }

  #hasReadingList(listId: ReadingListId): boolean {
    return this.#exec(sql`SELECT id FROM reading_list WHERE id = ${listId}`).toArray().length > 0;
  }

  addDocumentToReadingList(listId: ReadingListId, documentId: DocumentId, lang: Lang, createdAt: Timestamp): boolean {
    if (!this.#hasReadingList(listId)) return false;
    this.#exec(sql`INSERT INTO reading_list_document (list_id, document_id, lang, created_at)
      VALUES (${listId}, ${documentId}, ${lang}, ${createdAt}) ON CONFLICT DO NOTHING`);
    return true;
  }

  removeDocumentFromReadingList(listId: ReadingListId, documentId: DocumentId): boolean {
    if (!this.#hasReadingList(listId)) return false;
    this.#exec(sql`DELETE FROM reading_list_document WHERE list_id = ${listId} AND document_id = ${documentId}`);
    return true;
  }

  readingListDocuments(
    id: ReadingListId,
    lang: Lang | undefined,
    page: PageRequest<ReadingKey>,
  ): Paginated<{ readonly documentId: DocumentId; readonly createdAt: Timestamp }, ReadingKey> | null {
    if (!this.#hasReadingList(id)) return null;
    const { limit } = page;
    const rows = this.#exec(readingListDocumentsQuery(id, lang, page))
      .toArray()
      .map((row) => ({ documentId: schemas.DocumentId.parse(row["documentId"]), createdAt: schemas.Timestamp.parse(row["createdAt"]) }));
    return paginate(
      rows.map((item) => ({ item, key: [item.createdAt, item.documentId] as const })),
      limit,
    );
  }

  /** Counts the action once more in its window, unless the window has its limit already. The
   * first time, or once the window is over, a window starts now. */
  take(action: RateAction, now: Timestamp, { limit, windowSeconds }: RateLimit): RateOutcome {
    return this.ctx.storage.transactionSync((): RateOutcome => {
      const row = this.#exec(sql`SELECT started_at, count FROM rate_window WHERE action = ${action}`).toArray()[0];
      const nowMs = Date.parse(now);
      const windowEndMs = row === undefined ? null : Date.parse(schemas.Timestamp.parse(row["started_at"])) + windowSeconds * 1000;
      if (windowEndMs === null || nowMs >= windowEndMs) {
        this.#exec(sql`INSERT INTO rate_window (action, started_at, count) VALUES (${action}, ${now}, 1)
          ON CONFLICT (action) DO UPDATE SET started_at = excluded.started_at, count = excluded.count`);
        return { kind: "taken" };
      }
      if (Number(row?.["count"]) >= limit) {
        return { kind: "limited", retryAfterSeconds: Math.max(1, Math.ceil((windowEndMs - nowMs) / 1000)) };
      }
      this.#exec(sql`UPDATE rate_window SET count = count + 1 WHERE action = ${action}`);
      return { kind: "taken" };
    });
  }

  async #migrate(target: number): Promise<void> {
    const migrations = await (checksummed ??= withChecksums(MIGRATIONS));
    const { kept, revert } = await this.#revertEdited(applied(this.#log()), migrations);
    const found = problems(kept, migrations);
    if (found.length > 0) throw new MigrationError(found.join("; "));
    for (const step of [...revert, ...plan(kept.length, target, migrations)]) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(step.sql);
        this.#exec(
          sql`INSERT INTO migration_log (version, name, direction, checksum, down, applied_at)
            VALUES ${sql.tuple([step.version, step.name, step.direction, step.checksum, step.down, new Date().toISOString()])}`,
        );
      });
    }
    this.optimize();
  }

  /** The applied migrations that stay, and the step that reverts an edited last one where that's allowed */
  async #revertEdited(stack: LogEntry[], migrations: readonly Checksummed[]): Promise<{ kept: LogEntry[]; revert: Step[] }> {
    const step = this.env.MUTABLE_FINAL_USER_MIGRATION === "true" ? await revertEdited(stack, migrations) : null;
    return step === null ? { kept: stack, revert: [] } : { kept: stack.slice(0, -1), revert: [step] };
  }

  #log(): LogEntry[] {
    this.ctx.storage.transactionSync(() => {
      this.#exec(sql`
        CREATE TABLE IF NOT EXISTS migration_log (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          version INTEGER NOT NULL CHECK (version > 0),
          name TEXT NOT NULL,
          direction TEXT NOT NULL CHECK (direction IN ('up', 'down')),
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL CHECK (applied_at IS strftime('%Y-%m-%dT%H:%M:%fZ', applied_at)),
          down TEXT CHECK (direction = 'up' OR down IS NULL)
        ) STRICT;
        CREATE TRIGGER IF NOT EXISTS migration_log_no_update BEFORE UPDATE ON migration_log
          BEGIN SELECT RAISE(ABORT, 'migration_log is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS migration_log_no_delete BEFORE DELETE ON migration_log
          BEGIN SELECT RAISE(ABORT, 'migration_log is append-only'); END;
      `);
    });
    return this.#exec(sql`SELECT seq, version, name, direction, checksum, down, applied_at AS "appliedAt" FROM migration_log ORDER BY seq`)
      .toArray()
      .map((row) => LogEntry.parse(row));
  }
}
