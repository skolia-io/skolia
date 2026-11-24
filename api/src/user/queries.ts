// Queries of the user Durable Object (src/worker/user.ts) that the tests check the plans of.

import type { CardId, CardListing, LemmaId, ReadingKey, ReadingListId, Lang, Timestamp, WordCardKind } from "@skolia/shared/api";
import type { PageRequest } from "@skolia/shared/page";
import { col, desc, eq, gt, lit, lt, row, select, type Query } from "@skolia/util/query";
import { sql, type Sql } from "@skolia/util/sql";

export function readingListDocumentsQuery(id: ReadingListId, lang: Lang | undefined, { after, limit }: PageRequest<ReadingKey>): Query {
  return select({ documentId: "document_id", createdAt: "created_at" })
    .from("reading_list_document")
    .where(eq("list_id", id), lang !== undefined && eq("lang", lang), after !== undefined && lt(row("created_at", "document_id"), after))
    .orderBy(desc("created_at"), desc("document_id"))
    .limit(limit + 1);
}

/** A cloze card's text, and where its blank starts, as card_blank indexes them: a query
 * seeks it only if it spells them the same. */
export const BLANK_DOCUMENT = sql`card.data ->> '$.documentId'`;
export const BLANK_START = sql`card.data ->> '$.blankStart'`;

/** A card's words, as a JSON array, in order (card_word_card). */
const LEMMA_IDS = sql`(SELECT json_group_array(lemma_id) FROM (SELECT words.lemma_id FROM card_word AS words WHERE words.card_id = card.id ORDER BY words.lemma_id))`;

/** A card's columns, as a Card once parsed. */
const LISTED_CARD = {
  id: "card.id",
  lemmaIds: LEMMA_IDS,
  kind: "card.kind",
  createdAt: "card.created_at",
  learningWords: "card.learning_words",
  scheduleStatus: "card.schedule_status",
  dueAt: "card.due_at",
  scheduledDays: "card.scheduled_days",
  lastReviewedAt: sql`card.fsrs ->> '$.lastReviewAt'`,
  data: "card.data",
};

/** A page of cards, and one more if there is one. A language's or a word's, newest first:
 * those before the page's key, which card_listed or card_word_listed seeks to.
 * A text's: those after the page's key, by cloze's (document_id, blank_start). */
export function cardsQuery(listing: CardListing): Query {
  if ("documentId" in listing) {
    const { documentId, after, limit } = listing;
    return select(LISTED_CARD)
      .from("card")
      .where(eq("card.kind", lit("cloze")), eq(BLANK_DOCUMENT, documentId), after !== undefined && gt(BLANK_START, after[0]))
      .orderBy(BLANK_START)
      .limit(limit + 1);
  }
  const { after, limit } = listing;
  if ("lemmaId" in listing) {
    return select(LISTED_CARD)
      .from("card_word")
      .join("card", eq("card.id", col("card_word.card_id")))
      .where(eq("card_word.lemma_id", listing.lemmaId), after !== undefined && lt(row("card_word.created_at", "card_word.card_id"), after))
      .orderBy(desc("card_word.created_at"), desc("card_word.card_id"))
      .limit(limit + 1);
  }
  return select(LISTED_CARD)
    .from("card")
    .where(eq("card.lang", listing.lang), after !== undefined && lt(row("card.created_at", "card.id"), after))
    .orderBy(desc("card.created_at"), desc("card.id"))
    .limit(limit + 1);
}

/** The word's card of a word kind (card_word_kind). */
export const wordCardQuery = (lemmaId: LemmaId, kind: WordCardKind): Sql =>
  sql`SELECT card_id AS id FROM card_word WHERE lemma_id = ${lemmaId} AND kind = ${kind} AND kind IN ('recognition', 'production')`;

/** A card's columns, as a ScheduledCard once parsed. */
const SCHEDULED = sql`card.id AS id, ${LEMMA_IDS} AS "lemmaIds", card.kind AS kind, card.schedule_status = 'new' AS "isNew",
  card.due_at AS "dueAt", card.data AS data`;

/** A language's cards due by now, soonest first, of words still being learnt (card_due). */
export const dueQuery = (lang: Lang, now: Timestamp, limit: number): Sql =>
  sql`SELECT ${SCHEDULED} FROM card
    WHERE card.lang = ${lang} AND card.learning_words > 0 AND card.schedule_status != 'new' AND card.due_at <= ${now}
    ORDER BY card.due_at LIMIT ${limit}`;

/** How many of a language's cards are due by now. */
export const dueCountQuery = (lang: Lang, now: Timestamp): Sql =>
  sql`SELECT count(*) AS n FROM card
    WHERE card.lang = ${lang} AND card.learning_words > 0 AND card.schedule_status != 'new' AND card.due_at <= ${now}`;

/** The first n words not yet started, in the order they were added (word_unstarted). */
const pickedWords = (lang: Lang, n: number): Sql =>
  sql`SELECT word.lemma_id FROM word WHERE word.lang = ${lang} AND word.state = 'learning' AND word.started_at IS NULL AND word.cards > 0
    ORDER BY word.added_at, word.lemma_id LIMIT ${n}`;

/** The new cards to show, by id: those whose words are all started and one still learnt
 * (card_ready, named, as SQLite rates it no better than card_listed when it needn't sort),
 * the first limit of them; and those the picked words bring, every word of theirs
 * not yet started being one of them (card_word's key). */
const freshIds = (lang: Lang, picked: number, limit: number | null): Sql => sql`
  SELECT id FROM (SELECT card.id FROM card INDEXED BY card_ready
    WHERE card.lang = ${lang} AND card.schedule_status = 'new' AND card.unstarted_words = 0 AND card.learning_words > 0
    ORDER BY card.created_at, card.kind DESC, card.id${limit === null ? sql`` : sql` LIMIT ${limit}`})
  UNION
  SELECT brought.card_id FROM picked CROSS JOIN card_word AS brought ON brought.lemma_id = picked.lemma_id
    CROSS JOIN card ON card.id = brought.card_id
    WHERE card.unstarted_words = (SELECT count(*) FROM card_word AS mine WHERE mine.card_id = card.id AND mine.lemma_id IN picked)`;

/** The first limit new cards to show today, in the order they were made: those of started
 * words, and those of the first picked words not yet started, the allowance's. */
export const freshQuery = (lang: Lang, picked: number, limit: number): Sql =>
  sql`WITH picked AS (${pickedWords(lang, picked)})
    SELECT ${SCHEDULED} FROM (${freshIds(lang, picked, limit)}) AS fresh CROSS JOIN card ON card.id = fresh.id
    ORDER BY card.created_at, card.kind DESC, card.id LIMIT ${limit}`;

/** How many new cards freshQuery shows with no limit. */
export const freshCountQuery = (lang: Lang, picked: number): Sql =>
  sql`WITH picked AS (${pickedWords(lang, picked)}) SELECT count(*) AS n FROM (${freshIds(lang, picked, null)})`;

/** How many of a language's words were started since the time (word_started). */
export const startedSinceQuery = (lang: Lang, since: Timestamp): Sql =>
  sql`SELECT count(*) AS n FROM word WHERE word.lang = ${lang} AND word.started_at >= ${since}`;

/** Starts the card's words not yet started (card_word_card, then word's key). */
export const startQuery = (cardId: CardId, now: Timestamp): Sql =>
  sql`UPDATE word SET started_at = ${now}
    WHERE word.started_at IS NULL AND word.lemma_id IN (SELECT words.lemma_id FROM card_word AS words WHERE words.card_id = ${cardId})`;

/** Sets the card's known words back to learning (card_word_card, then word's key), which puts
 * their cards in reviews (word_state_counted). */
export const relearnQuery = (cardId: CardId): Sql =>
  sql`UPDATE word SET state = 'learning'
    WHERE word.state != 'learning' AND word.lemma_id IN (SELECT words.lemma_id FROM card_word AS words WHERE words.card_id = ${cardId})`;
