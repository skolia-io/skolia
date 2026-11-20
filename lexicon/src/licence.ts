// What the lexicon is licensed under and who to credit, in every response. Its senses,
// relations and pronunciations (and English and French forms) are Wiktionary's, through
// kaikki.org's extracts, under CC BY-SA 4.0, so the lexicon is too: share-alike carries
// over to what's made from it. Polish forms are Morfeusz 2's, generated from SGJP under
// BSD 2-clause, which allows that. The same credits, as a sentence, are each language's
// ATTRIBUTION in analysis/src/skolia_analysis/lang/{lang}/lexicon.py, which bundles carry;
// keep the two alike. Walenty's valency frames and Commons' recordings are in bundles but
// not in this lexicon, so they're not credited here.
import type { Lang } from "@skolia/shared/api";

/** A licence: its SPDX identifier, its deed and a sentence that says it. */
export type License = { readonly type: string; readonly url: string; readonly text: string };

/** Where part of an entry comes from, credited as CC licences ask: its title, author,
 * source and licence (an SPDX identifier). via: where skolia took it from, when that isn't
 * the source itself. */
export type Attribution = {
  readonly title: string;
  readonly author: string;
  readonly url: string;
  readonly license: string;
  readonly via?: string;
  readonly provides: string;
};

export const LICENSE: License = {
  type: "CC-BY-SA-4.0",
  url: "https://creativecommons.org/licenses/by-sa/4.0/",
  text:
    "This lexicon is licensed under a Creative Commons Attribution-ShareAlike 4.0 International License. " +
    "It's adapted from Wiktionary and the other sources each entry credits; credit them, and share what you make from it under the same licence.",
};

/** The License header (RFC 8288) every response has, as well as the license in its body. */
export const LICENSE_LINK = `<${LICENSE.url}>; rel="license"`;

/** Each language's section heading on English Wiktionary, which kaikki.org extracts. */
const WIKTIONARY_SECTION: Record<Lang, string> = { en: "English", fr: "French", pl: "Polish" };

const WIKTIONARY = {
  author: "Wiktionary contributors",
  license: "CC-BY-SA-4.0",
  via: "https://kaikki.org",
} as const;

/** What a language's Wiktionary entries give, and the sources besides. */
const PROVIDES: Record<Lang, { readonly wiktionary: string; readonly others: readonly Attribution[] }> = {
  en: { wiktionary: "senses, relations, pronunciations and forms", others: [] },
  fr: { wiktionary: "senses, relations, pronunciations and forms", others: [] },
  pl: {
    wiktionary: "senses, relations and pronunciations",
    others: [
      {
        title: "Morfeusz 2 and the Grammatical Dictionary of Polish (SGJP)",
        // As morfeusz.sgjp.pl/doc/license/ names them: the inflection data's authors, and the program's copyright holder
        author:
          "Zygmunt Saloni, Włodzimierz Gruszczyński, Marcin Woliński, Robert Wołosz and Danuta Skowrońska (SGJP data); " +
          "Instytut Podstaw Informatyki PAN (Morfeusz 2)",
        url: "http://morfeusz.sgjp.pl",
        license: "BSD-2-Clause",
        provides: "forms",
      },
    ],
  },
};

/** The page on English Wiktionary for the lemma, at the language's section. */
export function wiktionaryUrl(lang: Lang, lemma: string): string {
  return `https://en.wiktionary.org/wiki/${encodeURIComponent(lemma)}#${WIKTIONARY_SECTION[lang]}`;
}

/** The sources of a language's lexicon as a whole. */
export function sources(lang: Lang): readonly Attribution[] {
  const { wiktionary, others } = PROVIDES[lang];
  return [{ title: "Wiktionary", url: "https://en.wiktionary.org", provides: wiktionary, ...WIKTIONARY }, ...others];
}

/** The sources of one entry: its Wiktionary page, and the language's other sources. */
export function attribution(lang: Lang, lemma: string): readonly Attribution[] {
  const { wiktionary, others } = PROVIDES[lang];
  return [{ title: lemma, url: wiktionaryUrl(lang, lemma), provides: wiktionary, ...WIKTIONARY }, ...others];
}
