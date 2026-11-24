// What the reader needs from a language: everything outside lang/ goes through this.
import type { Token } from "@skolia/shared/schema";
import type { Layout, MergeLabels } from "../paradigm.ts";

export interface Language {
  paradigm: Layout;
  /** One label for merged table rows or columns; default: joined with "/". */
  mergeLabels?: MergeLabels;
  /** Nouns, adjectives and pronouns all take cases (Polish), so the sentence view shows
   * each word's case; English and French mark case only on a few pronouns. */
  cases: boolean;
  /** A label for a token that's only part of a word (the Polish person ending -em), shown
   * instead of its part of speech, without meanings or forms; null for a word. */
  partOfWord(token: Token): string | null;
}
