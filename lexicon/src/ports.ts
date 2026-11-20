// What the app needs of the lexicon, without Workers types, so the
// reader and the API can import the app's types (AppType) and the RPC's.
import type { FeatureSets, Lang, LemmaId } from "@skolia/shared/api";
import type { Entry, Pronunciation, Recording, Relation, Upos } from "@skolia/shared/schema";

/** Entries that share a spelling, at most: one per part of speech, so a handful. */
export const MAX_HOMOGRAPHS = 20;

/** The relations pointing at an entry that a response gives, at most, by source id. */
export const MAX_INCOMING = 50;

/** What a lookup brings besides the entries asked for. related: the entries their
 * relations point at; incoming: the relations that point at each, MAX_INCOMING at most. */
export type Include = { readonly related: boolean; readonly incoming: boolean };

export const NOTHING_MORE: Include = { related: false, incoming: false };

/** The relations pointing at an entry, from its sources, and whether there were more than
 * MAX_INCOMING. */
export type Incoming = { readonly relations: readonly Relation[]; readonly truncated: boolean };

/** One language's part of a lookup, all from one version. */
export type Found = {
  readonly entries: readonly Entry[];
  readonly related: readonly Entry[];
  readonly incoming: ReadonlyMap<LemmaId, Incoming>;
  readonly featureSets: FeatureSets | null;
};

export type FormAudio = { readonly pronunciations: Pronunciation[]; readonly recordings: Recording[] };

/** Each language's lexicon. A version's rows don't change once loaded, so a caller reads
 * the version first (served) and looks up in it: what it caches under a version is what
 * that version has. */
export interface Lexicon {
  /** The version the language's lexicon serves, or null before one is loaded. */
  formAudio(lang: Lang, version: string, form: string, upos: Upos): Promise<FormAudio>;
  served(lang: Lang): Promise<string | null>;
  /** The entries with these ids, in version. */
  byIds(lang: Lang, version: string, ids: readonly LemmaId[], include: Include): Promise<Found>;
  /** Resolve a token's id against the lexicon, including spelling and POS fallbacks. */
  resolve(lang: Lang, version: string, id: LemmaId, include: Include): Promise<Found>;
  /** The entries spelt lemma, one per part of speech, MAX_HOMOGRAPHS at most, in version. */
  byLemma(lang: Lang, version: string, lemma: string, include: Include): Promise<Found>;
}
