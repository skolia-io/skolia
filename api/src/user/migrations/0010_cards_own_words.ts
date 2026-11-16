// What the user knows of a word is its cards' state: word goes. card.active is a card's state,
// 1 learning and 0 known. A word known or ignored that has no cards gets a known recognition
// card, as new (a ts-fsrs new card's JSON, which only its id and due time vary), so marking
// it outlives the table; an ignored word's cards are known, as nothing ignores a card. The id
// is a random version 4 UUID, made in a MATERIALIZED CTE so the card and its JSON share it.
// card_lemma gains created_at, for a word's cards newest first.
import { iso } from "@skolia/util/checks";

export const up = `UPDATE card SET active = 0 WHERE lemma_id IN (SELECT lemma_id FROM word WHERE status != 'active');
WITH marked AS MATERIALIZED (
  SELECT lemma_id, updated_at,
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-'
      || substr('89ab', 1 + abs(random()) % 4, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) AS id
  FROM word
  WHERE status != 'active' AND NOT EXISTS (SELECT 1 FROM card WHERE card.lemma_id = word.lemma_id)
)
INSERT INTO card (id, lemma_id, kind, created_at, active, fsrs)
  SELECT id, lemma_id, 'recognition', updated_at, 0,
    json_object('stability', 0, 'stabilityFast', 0, 'difficulty', 0, 'state', 0, 'scheduleStatus', 'new', 'dueAt', updated_at,
      'lastReviewAt', NULL, 'cardId', id, 'reps', 0, 'lapses', 0, 'scheduledDays', 0, 'learningStep', 0)
  FROM marked;
DROP TABLE word;
DROP INDEX card_lemma;
CREATE INDEX card_lemma ON card (lemma_id, created_at)`;

// A word with a learning card is active, and one whose cards are all known is known; its
// cards then all take the word's state, as word kept them.
export const down = `CREATE TABLE word (
  lemma_id TEXT NOT NULL PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active', 'known', 'ignored')),
  updated_at TEXT NOT NULL ${iso("updated_at")}
) STRICT, WITHOUT ROWID;
INSERT INTO word (lemma_id, status, updated_at)
  SELECT lemma_id, iif(max(active) = 1, 'active', 'known'), max(created_at) FROM card GROUP BY lemma_id;
UPDATE card SET active = (SELECT status = 'active' FROM word WHERE word.lemma_id = card.lemma_id);
DROP INDEX card_lemma;
CREATE INDEX card_lemma ON card (lemma_id)`;
