import type { Language } from "../types.ts";
import { layout, mergeLabels } from "./paradigm.ts";

// NKJP's class for the person ending split off a fused word (dałem -> dał + em)
const PERSON_ENDING = "aglt";

export const polish: Language = {
  paradigm: layout,
  mergeLabels,
  cases: true,
  partOfWord: (token) => ((token.xpos ?? "").startsWith(PERSON_ENDING) ? "person ending" : null),
};
