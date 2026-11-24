// What the reader needs from a language: everything outside lang/ goes through this.
import type { Entry, Token } from "@skolia/shared/schema";
import type { Layout, MergeLabels } from "../paradigm.ts";

/** A way the word combines with others: "szukać kogoś/czegoś [gen.]". */
export interface Use {
  /** The headword as the pattern starts: "bać się". */
  head: string;
  /** The rest, with bracketed labels: "kogoś/czegoś [gen.]". */
  pattern: string;
  tags: string[];
  /** Contains fixed words: an idiom. */
  idiom: boolean;
  /** The sentence's own complements fit this one. */
  here: boolean;
}

export interface Language {
  paradigm: Layout;
  /** One label for merged table rows or columns; default: joined with "/". */
  mergeLabels?: MergeLabels;
  /** Nouns, adjectives and pronouns all take cases (Polish), so the sentence view shows
   * each word's case; English and French mark case only on a few pronouns. */
  cases: boolean;
  /** How the word combines with others, those the sentence uses first. */
  uses(entry: Entry, tokens: Token[], index: number): Use[];
  /** A label for a token that's only part of a word (the Polish person ending -em), shown
   * instead of its part of speech, without meanings or forms; null for a word. */
  partOfWord(token: Token): string | null;
}
