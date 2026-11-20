// Looking a token up in its document's bundle.
import type { Bundle, Entry, Feats, Pronunciation, Recording, Relation, Sense, Token, Upos } from "@skolia/shared/schema";

/** The sentence decides these, not the form, so paradigms leave them out (see the
 * BundleParadigm docstring in analysis/src/skolia_analysis/lexicon/schema.py). */
const CONTEXTUAL: ReadonlySet<string> = new Set(["PronType", "ExtPos"]);

/** The id of the token's entry, after the bundle's fallbacks (Old in "Old Town" is
 * en:old:ADJ): the id words and cards are kept under. */
export function entryIdFor(bundle: Bundle, token: Token): string | undefined {
  if (token.lemma_id === null) return undefined;
  const id = bundle.lookup[token.lemma_id] ?? token.lemma_id;
  return id in bundle.entries ? id : undefined;
}

export function entryFor(bundle: Bundle, token: Token): Entry | undefined {
  const id = entryIdFor(bundle, token);
  return id === undefined ? undefined : bundle.entries[id];
}

/** How a token's text or an entry's lemma is said, keyed as pronunciation_key in
 * analysis/src/skolia_analysis/lexicon/schema.py. */
export function pronunciationsOf(bundle: Bundle, word: string, upos: Upos): Pronunciation[] {
  return bundle.pronunciations?.[`${word}:${upos}`] ?? [];
}

/** The first transcription for each accent: Wiktionary lists the usual one first, then
 * variants (family has seven UK ones). */
export function mainPronunciations(said: Pronunciation[]): Pronunciation[] {
  const seen = new Set<string>();
  return said.filter((p) => {
    const accents = p.accents?.join(",") ?? "";
    if (seen.has(accents)) return false;
    seen.add(accents);
    return true;
  });
}

/** Recordings of a token's text or an entry's lemma, keyed like pronunciationsOf. */
export function recordingsOf(bundle: Bundle, word: string, upos: Upos): Recording[] {
  return bundle.recordings?.[`${word}:${upos}`] ?? [];
}

/** Every feature the token has (bar contextual ones) has the same value in feats. */
export function featsMatch(feats: Feats, token: Feats): boolean {
  return Object.entries(token).every(([key, value]) => CONTEXTUAL.has(key) || (feats as Record<string, string>)[key] === value);
}

function selects(sense: Sense, token: Feats): boolean {
  return sense.when === undefined || sense.when.some((w) => featsMatch(token, w));
}

export interface RankedSense {
  sense: Sense;
  /** False when the sense needs other features (pies the cop vs the dog). */
  fits: boolean;
}

/** Senses the token's features select first, otherwise in Wiktionary's order. */
export function rankSenses(senses: readonly Sense[], token: Feats): RankedSense[] {
  const ranked = senses.map((sense) => ({ sense, fits: selects(sense, token) }));
  return [...ranked.filter((r) => r.fits), ...ranked.filter((r) => !r.fits)];
}

/** What a word's meaning depends on: a bundle's Entry or the API's LexiconEntry. */
type Meaning = { readonly senses: readonly Sense[]; readonly relations: readonly Relation[] };

/** Wiktionary's tags for a verb's aspect, which on a borrowed sense describe the target. */
const ASPECT_TAGS: ReadonlySet<string> = new Set(["perfective", "imperfective"]);

/** The entries a word with no senses of its own takes its meaning from, its relations'
 * targets that find has; none for a word with senses. */
export function lenders<E>(entry: Meaning, find: (lemmaId: string) => E | undefined): E[] {
  if (entry.senses.length > 0) return [];
  return entry.relations.flatMap((relation) => {
    const target = relation.lemma_id === undefined ? undefined : find(relation.lemma_id);
    return target === undefined ? [] : [target];
  });
}

/** An entry's senses, or with none of its own, the ones its relations name in their
 * targets: zgolić, which Wiktionary only lists as the perfective of golić's "to down, to
 * soak (to drink)", means that and not "to shave". A borrowed sense keeps its gloss and
 * tags but not aspect tags, examples or selectors, which describe the target. */
export function sensesOf(entry: Meaning, find: (lemmaId: string) => { readonly senses: readonly Sense[] } | undefined): Sense[] {
  if (entry.senses.length > 0) return [...entry.senses];
  return entry.relations.flatMap((relation) => {
    const target = relation.lemma_id === undefined ? undefined : find(relation.lemma_id);
    if (target === undefined) return [];
    const named = relation.sense_indexes?.flatMap((i) => target.senses[i] ?? []) ?? target.senses;
    return named.map((sense) => ({ gloss: sense.gloss, tags: sense.tags.filter((tag) => !ASPECT_TAGS.has(tag)) }));
  });
}
