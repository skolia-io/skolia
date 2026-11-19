// Queries of the user Durable Object (src/worker/user.ts) that the tests check the plans of.

import type { CardListing, ReadingFilter, ReadingKey, ReadingListId, Lang } from "@skolia/shared/api";
import type { PageRequest } from "@skolia/shared/page";
import { desc, eq, gt, lit, lt, row, select, type Query } from "@skolia/util/query";
import { sql } from "@skolia/util/sql";

/** A reading_progress row's columns, as a ReadingEntry. */
export const READING_ENTRY = { status: "status", addedAt: "added_at", updatedAt: "updated_at" };

/** A page of a status's reading list, latest change first, and one more if there is one:
 * those before the page's key, which reading_list_status, or with a language
 * reading_list_lang, seeks to. */
export function readingProgressQuery({ status, lang }: ReadingFilter, { after, limit }: PageRequest<ReadingKey>): Query {
  return select({ documentId: "document_id", ...READING_ENTRY })
    .from("reading_progress")
    .where(lang !== undefined && eq("lang", lang), eq("status", status), after !== undefined && lt(row("updated_at", "document_id"), after))
    .orderBy(desc("updated_at"), desc("document_id"))
    .limit(limit + 1);
}

export function readingListDocumentsQuery(id: ReadingListId, lang: Lang | undefined, { after, limit }: PageRequest<ReadingKey>) {
  return sql`SELECT document_id AS documentId, added_at AS addedAt FROM reading_list_document
    WHERE list_id = ${id} ${lang === undefined ? sql`` : sql`AND lang = ${lang}`}
    ${after === undefined ? sql`` : sql`AND (added_at, document_id) < (${after[0]}, ${after[1]})`}
    ORDER BY added_at DESC, document_id DESC LIMIT ${limit + 1}`;
}

/** A cloze card's text, and where its blank starts, as card_blank indexes them: a query
 * seeks it only if it spells them the same. */
export const BLANK_DOCUMENT = sql`card.data ->> '$.documentId'`;
export const BLANK_START = sql`card.data ->> '$.blankStart'`;

/** A card's columns, as a Card once parsed. */
const LISTED_CARD = {
  id: "card.id",
  lemmaId: "card.lemma_id",
  kind: "card.kind",
  createdAt: "card.created_at",
  active: "card.active",
  scheduleStatus: "card.schedule_status",
  dueAt: "card.due_at",
  scheduledDays: "card.scheduled_days",
  lastReviewedAt: sql`card.fsrs ->> '$.lastReviewAt'`,
  data: "card.data",
};

/** A page of cards, and one more if there is one. A language's or a word's, newest first:
 * those before the page's key, which card_listed or card_lemma seeks to.
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
  return select(LISTED_CARD)
    .from("card")
    .where(
      "lemmaId" in listing ? eq("card.lemma_id", listing.lemmaId) : eq("card.lang", listing.lang),
      after !== undefined && lt(row("card.created_at", "card.id"), after),
    )
    .orderBy(desc("card.created_at"), desc("card.id"))
    .limit(limit + 1);
}
