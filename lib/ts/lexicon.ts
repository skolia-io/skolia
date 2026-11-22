// Lexicon display helpers.
import type { Derivation, Feats, Pronunciation, Relation, Sense } from "@skolia/shared/schema";
import { featureWords } from "./ud.ts";

/** The sentence decides these, not the form, so paradigms leave them out (see the
 * EntryParadigm docstring in analysis/src/skolia_analysis/lexicon/schema.py). */
const CONTEXTUAL: ReadonlySet<string> = new Set(["PronType", "ExtPos"]);

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
