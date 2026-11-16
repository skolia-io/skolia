import * as m0001 from "./0001_known_lemma.ts";
import * as m0002 from "./0002_flashcards.ts";
import * as m0003 from "./0003_reading_position.ts";
import * as m0004 from "./0004_cloze.ts";
import * as m0005 from "./0005_card_groups.ts";
import * as m0006 from "./0006_reading_list.ts";
import * as m0007 from "./0007_at_columns.ts";
import * as m0008 from "./0008_row_count.ts";
import * as m0009 from "./0009_card_list.ts";
import * as m0010 from "./0010_cards_own_words.ts";
import * as m0011 from "./0011_count_cards.ts";
import * as m0012 from "./0012_card_data.ts";

export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "known_lemma", ...m0001 },
  { version: 2, name: "flashcards", ...m0002 },
  { version: 3, name: "reading_position", ...m0003 },
  { version: 4, name: "cloze", ...m0004 },
  { version: 5, name: "card_groups", ...m0005 },
  { version: 6, name: "reading_list", ...m0006 },
  { version: 7, name: "at_columns", ...m0007 },
  { version: 8, name: "row_count", ...m0008 },
  { version: 9, name: "card_list", ...m0009 },
  { version: 10, name: "cards_own_words", ...m0010 },
  { version: 11, name: "count_cards", ...m0011 },
  { version: 12, name: "card_data", ...m0012 },
];
