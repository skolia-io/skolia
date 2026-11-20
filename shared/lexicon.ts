// Looking a token up in its document's bundle.
import type { Bundle, Derivation, Entry, Feats, Pronunciation, Recording, Relation, Sense, Token, Upos } from "@skolia/shared/schema";
import { featureWords } from "./ud.ts";

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

/** How a token's text is said, keyed as pronunciation_key in
 * analysis/src/skolia_analysis/lexicon/schema.py. An entry has its lemma's. */
export function pronunciationsOf(bundle: Bundle, word: string, upos: Upos): Pronunciation[] {
  return bundle.pronunciations[`${word}:${upos}`] ?? [];
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

/** Recordings of a token's text, keyed like pronunciationsOf. */
export function recordingsOf(bundle: Bundle, word: string, upos: Upos): Recording[] {
  return bundle.recordings[`${word}:${upos}`] ?? [];
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

const DERIVATION_LABEL: Record<Derivation, string> = {
  "agent-noun": "agent noun of",
  augmentative: "augmentative of",
  diminutive: "diminutive of",
  endearing: "endearing form of",
  feminine: "feminine of",
  frequentative: "frequentative of",
  iterative: "iterative of",
  masculine: "masculine of",
  "noun-from-verb": "noun from",
  perfective: "perfective of",
};

/** How a word stands to its relation's target, to go before the target: "diminutive of"
 * rubel, "perfective partner" zrobić, "regional form of" bzykać. */
export function relationLabel(relation: Relation): string {
  switch (relation.kind) {
    case "aspect-partner":
      return `${featureWords({ Aspect: relation.aspect }).join(" ")} partner`;
    case "derived-from":
      return DERIVATION_LABEL[relation.how];
    case "variant-of":
      return relation.tags.length > 0 ? `${relation.tags.join(", ")} form of` : "variant of";
    default: {
      const unknown: never = relation;
      return unknown;
    }
  }
}
