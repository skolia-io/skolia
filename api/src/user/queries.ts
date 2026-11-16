// Queries of the user Durable Object (src/worker/user.ts) that the tests check the plans of.

import type { CardListing, ReadingFilter, ReadingKey } from "@skolia/shared/api";
import type { PageRequest } from "@skolia/shared/page";
import { col, desc, eq, gt, lt, row, select, type Query } from "@skolia/util/query";
import { sql } from "@skolia/util/sql";

/** A reading_list row's columns, as a ReadingEntry. */
export const READING_ENTRY = { status: "status", addedAt: "added_at", updatedAt: "updated_at" };

/** A page of a status's reading list, latest change first, and one more if there is one:
 * those before the page's key, which reading_list_status, or with a language
 * reading_list_lang, seeks to. */
export function readingListQuery({ status, lang }: ReadingFilter, { after, limit }: PageRequest<ReadingKey>): Query {
  return select({ documentId: "document_id", ...READING_ENTRY })
    .from("reading_list")
    .where(lang !== undefined && eq("lang", lang), eq("status", status), after !== undefined && lt(row("updated_at", "document_id"), after))
    .orderBy(desc("updated_at"), desc("document_id"))
    .limit(limit + 1);
}

/** A card's columns, and its cloze's if it's a cloze card, as a Card once parsed. */
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
  documentId: "cloze.document_id",
  sentence: "cloze.sentence",
  sentenceStart: "cloze.sentence_start",
  blankStart: "cloze.blank_start",
  blankEnd: "cloze.blank_end",
  feats: "cloze.feats",
  why: "cloze.why",
};

/** A page of cards, and one more if there is one. A language's or a word's, newest first:
 * those before the page's key, which card_listed or card_lemma seeks to.
 * A text's: those after the page's key, by cloze's (document_id, blank_start). */
export function cardsQuery(listing: CardListing): Query {
  if ("documentId" in listing) {
    const { documentId, after, limit } = listing;
    return select(LISTED_CARD)
      .from("cloze")
      .join("card", eq("card.id", col("cloze.card_id")))
      .where(eq("cloze.document_id", documentId), after !== undefined && gt("cloze.blank_start", after[0]))
      .orderBy("cloze.blank_start")
      .limit(limit + 1);
  }
  const { after, limit } = listing;
  return select(LISTED_CARD)
    .from("card")
    .leftJoin("cloze", eq("cloze.card_id", col("card.id")))
    .where(
      "lemmaId" in listing ? eq("card.lemma_id", listing.lemmaId) : eq("card.lang", listing.lang),
      after !== undefined && lt(row("card.created_at", "card.id"), after),
    )
    .orderBy(desc("card.created_at"), desc("card.id"))
    .limit(limit + 1);
}
