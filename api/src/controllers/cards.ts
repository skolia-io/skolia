import type { Err, deleteCardErrors, makeCardErrors, reviewErrors, setWordStateErrors } from "../endpoint-errors.ts";
// Flashcards, reviews and settings, which live in each user's Durable Object, and
// the lexicon entries the cards show.
import {
  MAX_CARDS,
  MAX_LOOKUP,
  timestamp,
  type CardCounts,
  type Card,
  type CardId,
  type CardKey,
  type CardListing,
  type CardMade,
  type LemmaId,
  type Paginated,
  type Due,
  type FeatureSets,
  type Lang,
  type NewCard,
  type Reviewed,
  type ReviewRequest,
  type ScheduledCard,
  type Settings,
  type Timestamp,
  type Identity,
  type Word,
  type WordState,
} from "@skolia/shared/api";
import type { Entry } from "@skolia/shared/schema";
import type { Clock } from "../ports/index.ts";
import type { DocumentLookup } from "../ports/documents.ts";
import type { Lexicon } from "../ports/lexicon.ts";
import type { UserCards, UserSettings } from "../ports/users.ts";
import { noSuchDocument } from "./documents.ts";
import { NO_CONTENT, fail, ok, type Json, type NoContent, type Ok } from "./result.ts";

/** Most cards one due list has: a session's worth. */
const MAX_DUE = 200;
/** How far ahead of the server's clock a review's time may be. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** dayStart: when the user's day started, any ISO time; today's new cards count from it. */
export async function counts(deps: { users: UserCards } & Clock, user: Identity, dayStart: string): Promise<Ok<CardCounts[]>> {
  return ok(await deps.users.counts(user.id, timestamp(deps.now()), stored(dayStart)));
}

export async function due(
  deps: { users: UserCards; lexicon: Lexicon } & Clock,
  user: Identity,
  lang: Lang,
  dayStart: string,
): Promise<Ok<Due>> {
  const { cards, newLeft } = await deps.users.due(user.id, lang, timestamp(deps.now()), stored(dayStart), MAX_DUE);
  return ok({ ...(await withEntries(deps.lexicon, lang, cards)), newLeft });
}

export async function review(
  deps: { users: UserCards } & Clock,
  user: Identity,
  request: ReviewRequest,
): Promise<Ok<Reviewed> | Err<typeof reviewErrors, 400 | 404 | 409>> {
  if (Date.parse(request.at) > deps.now().getTime() + MAX_CLOCK_SKEW_MS) return fail(400, { code: "future-review" });
  const outcome = await deps.users.review(user.id, request, timestamp(deps.now()));
  switch (outcome.kind) {
    case "reviewed":
      return ok({ cardId: outcome.cardId, dueAt: outcome.dueAt });
    case "no-card":
      return fail(404, { code: "card-not-found" });
    case "out-of-order":
      return fail(409, { code: "review-too-old" });
    case "id-reused":
      return fail(409, { code: "review-id-conflict" });
  }
}

/** Whether the card's data refers only to what the user sees: a cloze card's text is one
 * they see. */
async function seesData(deps: { documents: DocumentLookup }, user: Identity, card: NewCard): Promise<boolean> {
  switch (card.kind) {
    case "recognition":
    case "production":
      return true;
    case "cloze":
      return (await deps.documents.visible(card.data.documentId, user.id)) !== null;
  }
}

/** 201 for a new card, 200 when the word had one of its kind, or the text had one at the
 * blank. */
export async function makeCard(
  deps: { users: UserCards; documents: DocumentLookup } & Clock,
  user: Identity,
  card: NewCard,
): Promise<Json<CardMade, 201> | Ok<CardMade> | Err<typeof makeCardErrors, 404 | 409>> {
  if (!(await seesData(deps, user, card))) return noSuchDocument();
  const made = await deps.users.makeCard(user.id, card, timestamp(deps.now()));
  switch (made.kind) {
    case "made":
      return { status: 201, body: { cardId: made.cardId } };
    case "had":
      return ok({ cardId: made.cardId });
    case "full":
      return fail(409, { code: "limit-exceeded", resource: "cards", limit: MAX_CARDS });
  }
}

export async function cards(deps: { users: UserCards }, user: Identity, listing: CardListing): Promise<Ok<Paginated<Card, CardKey>>> {
  return ok(await deps.users.cards(user.id, listing));
}

/** Those of the words the user has: a word stays, with its state, once its cards are deleted. */
export async function words(
  deps: { users: UserCards },
  user: Identity,
  lemmaIds: readonly LemmaId[],
): Promise<Ok<{ words: readonly Word[] }>> {
  return ok({ words: await deps.users.words(user.id, lemmaIds) });
}

/** known takes the word's cards out of reviews; learning puts them back where they were. */
export async function setWordState(
  deps: { users: UserCards },
  user: Identity,
  lemmaId: LemmaId,
  state: WordState,
): Promise<NoContent | Err<typeof setWordStateErrors, 404>> {
  return (await deps.users.setWordState(user.id, lemmaId, state)) ? NO_CONTENT : fail(404, { code: "word-not-found" });
}

/** Any kind of card, with its reviews. */
export async function deleteCard(
  deps: { users: UserCards },
  user: Identity,
  cardId: CardId,
): Promise<NoContent | Err<typeof deleteCardErrors, 404>> {
  return (await deps.users.deleteCard(user.id, cardId)) ? NO_CONTENT : fail(404, { code: "card-not-found" });
}

export async function settings(deps: { users: UserSettings }, user: Identity): Promise<Ok<Settings>> {
  return ok(await deps.users.settings(user.id));
}

export async function setSettings(deps: { users: UserSettings }, user: Identity, settings: Settings): Promise<NoContent> {
  await deps.users.setSettings(user.id, settings);
  return NO_CONTENT;
}

function stored(time: string): Timestamp {
  return timestamp(new Date(time));
}

/** The cards with their lexicon entries, and the feature sets the entries' paradigms use,
 * looked up MAX_LOOKUP lemmas at a time. */
async function withEntries(lexicon: Lexicon, lang: Lang, cards: ScheduledCard[]): Promise<Pick<Due, "cards" | "featureSets">> {
  const entries = new Map<string, Entry>();
  const featureSets: FeatureSets = {};
  const ids = [...new Set(cards.flatMap((card) => card.lemmaIds))];
  for (let i = 0; i < ids.length; i += MAX_LOOKUP) {
    const found = await lexicon.entries(ids.slice(i, i + MAX_LOOKUP));
    for (const entry of found.entries) entries.set(entry.lemma_id, entry);
    Object.assign(featureSets, found.featureSets[lang]);
  }
  return {
    cards: cards.map((card) => ({ ...card, entries: card.lemmaIds.flatMap((id) => entries.get(id) ?? []) })),
    featureSets,
  };
}
