import type { Card, LemmaId, Word } from "@skolia/shared/api";

/** A word the user has: its stored state, and its cards, which may be none. */
export type UserWord = { readonly state: Word["state"]; readonly cards: readonly Card[] };

/** The words the user has, by lemma id. */
export type UserWords = ReadonlyMap<LemmaId, UserWord>;

/** new: the user hasn't the word, or is learning it and has no cards of it. known: they
 * know it, with cards or without, until they learn it again. learning: they're learning it. */
export type WordState = "new" | "learning" | "known";

export function wordState(word: UserWord | undefined): WordState {
  if (word === undefined) return "new";
  switch (word.state) {
    case "known":
      return "known";
    case "learning":
      return word.cards.length === 0 ? "new" : "learning";
    default: {
      const exhaustive: never = word.state;
      throw new Error(`unknown word state ${String(exhaustive)}`);
    }
  }
}
