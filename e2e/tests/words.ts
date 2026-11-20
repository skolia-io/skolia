import type { Lang, LemmaId } from "@skolia/shared/api";

/** A word in each language that every environment's lexicon has, previews' samples too
 * (wordfreq's 3,000 most common words), with a paradigm. */
export const WORDS: Record<Lang, LemmaId> = { en: "en:dog:NOUN", fr: "fr:chien:NOUN", pl: "pl:pies:NOUN" };
