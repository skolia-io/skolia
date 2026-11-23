import { iso, isoOrNull } from "@skolia/util/checks";

// Words, and cards of any kind that belong to one or more of them (card_word). A word has when
// the user added it, whether they're learning it or know it, when they started it (first
// answered one of its cards), and how many cards it has. A card keeps how many of its words
// aren't started yet and how many are being learnt, so the indexes that choose what to review
// seek only cards that can come up; the triggers below keep the three counts. Cards made before
// had no words, so they and their reviews are dropped: nobody was using them yet. New cards
// have one daily allowance, of words, so the settings for cloze cards go.

/** The change in the counts when a word joins a card (by 1) or leaves it (by -1). */
const joined = (link: "NEW" | "OLD", by: string) => `
  UPDATE word SET cards = cards + ${by} WHERE lemma_id = ${link}.lemma_id;
  UPDATE card SET
    unstarted_words = unstarted_words + ${by} * (SELECT started_at IS NULL FROM word WHERE lemma_id = ${link}.lemma_id),
    learning_words = learning_words + ${by} * (SELECT state = 'learning' FROM word WHERE lemma_id = ${link}.lemma_id)
  WHERE id = ${link}.card_id;`;

export const up = `
DROP TABLE review;
DROP TABLE card;
UPDATE row_count SET n = 0 WHERE name = 'card';
ALTER TABLE settings DROP COLUMN new_forms_per_day;
ALTER TABLE settings DROP COLUMN forms_with_words;

CREATE TABLE word (
  lemma_id TEXT NOT NULL PRIMARY KEY,
  lang TEXT GENERATED ALWAYS AS (substr(lemma_id, 1, instr(lemma_id, ':') - 1)) STORED NOT NULL,
  added_at TEXT NOT NULL ${iso("added_at")},
  state TEXT NOT NULL,
  started_at TEXT ${isoOrNull("started_at")},
  cards INTEGER NOT NULL DEFAULT 0 CHECK (cards >= 0)
) STRICT, WITHOUT ROWID;

CREATE INDEX word_unstarted ON word (lang, added_at) WHERE state = 'learning' AND started_at IS NULL AND cards > 0;
CREATE INDEX word_started ON word (lang, started_at) WHERE started_at IS NOT NULL;

CREATE TABLE card (
  id TEXT NOT NULL PRIMARY KEY,
  lang TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL ${iso("created_at")},
  fsrs TEXT NOT NULL CHECK (json_valid(fsrs)),
  due_at TEXT GENERATED ALWAYS AS (fsrs ->> '$.dueAt') STORED NOT NULL ${iso("due_at")},
  schedule_status TEXT GENERATED ALWAYS AS (fsrs ->> '$.scheduleStatus') STORED NOT NULL,
  scheduled_days REAL GENERATED ALWAYS AS (fsrs ->> '$.scheduledDays') STORED NOT NULL,
  data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data) AND json_type(data) = 'object'),
  unstarted_words INTEGER NOT NULL DEFAULT 0 CHECK (unstarted_words >= 0),
  learning_words INTEGER NOT NULL DEFAULT 0 CHECK (learning_words >= 0),
  UNIQUE (id, kind)
) STRICT, WITHOUT ROWID;

CREATE INDEX card_due ON card (lang, due_at) WHERE learning_words > 0 AND schedule_status != 'new';
CREATE INDEX card_ready ON card (lang, created_at, kind DESC) WHERE schedule_status = 'new' AND unstarted_words = 0 AND learning_words > 0;
CREATE INDEX card_listed ON card (lang, created_at);
CREATE UNIQUE INDEX card_blank ON card (data ->> '$.documentId', data ->> '$.blankStart') WHERE kind = 'cloze';

CREATE TRIGGER card_counted AFTER INSERT ON card BEGIN
  UPDATE row_count SET n = n + 1 WHERE name = 'card';
END;

CREATE TRIGGER card_uncounted AFTER DELETE ON card BEGIN
  UPDATE row_count SET n = n - 1 WHERE name = 'card';
END;

CREATE TABLE card_word (
  card_id TEXT NOT NULL,
  lemma_id TEXT NOT NULL REFERENCES word (lemma_id),
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL ${iso("created_at")},
  PRIMARY KEY (lemma_id, card_id),
  FOREIGN KEY (card_id, kind) REFERENCES card (id, kind) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX card_word_card ON card_word (card_id, lemma_id);
CREATE INDEX card_word_listed ON card_word (lemma_id, created_at);
CREATE UNIQUE INDEX card_word_kind ON card_word (lemma_id, kind) WHERE kind IN ('recognition', 'production');

CREATE TRIGGER card_word_added AFTER INSERT ON card_word BEGIN${joined("NEW", "1")}
END;

CREATE TRIGGER card_word_removed AFTER DELETE ON card_word BEGIN${joined("OLD", "-1")}
END;

CREATE TRIGGER word_start_counted AFTER UPDATE OF started_at ON word
  WHEN (OLD.started_at IS NULL) IS NOT (NEW.started_at IS NULL) BEGIN
  UPDATE card SET unstarted_words = unstarted_words + (NEW.started_at IS NULL) - (OLD.started_at IS NULL)
    WHERE id IN (SELECT card_id FROM card_word WHERE lemma_id = NEW.lemma_id);
END;

CREATE TRIGGER word_state_counted AFTER UPDATE OF state ON word
  WHEN (OLD.state = 'learning') IS NOT (NEW.state = 'learning') BEGIN
  UPDATE card SET learning_words = learning_words + (NEW.state = 'learning') - (OLD.state = 'learning')
    WHERE id IN (SELECT card_id FROM card_word WHERE lemma_id = NEW.lemma_id);
END;

CREATE TABLE review (
  id TEXT NOT NULL PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES card (id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
  reviewed_at TEXT NOT NULL ${iso("reviewed_at")}
) STRICT, WITHOUT ROWID;

CREATE INDEX review_card ON review (card_id, reviewed_at);
`;

// 0001's card and review, empty, and 0001's settings.
export const down = `
DROP TABLE review;
DROP TABLE card_word;
DROP TABLE card;
DROP TABLE word;
UPDATE row_count SET n = 0 WHERE name = 'card';
ALTER TABLE settings ADD COLUMN new_forms_per_day INTEGER NOT NULL DEFAULT 20 CHECK (new_forms_per_day BETWEEN 0 AND 1000);
ALTER TABLE settings ADD COLUMN forms_with_words INTEGER NOT NULL DEFAULT 1 CHECK (forms_with_words IN (0, 1));

CREATE TABLE "card" (
  id TEXT NOT NULL PRIMARY KEY,
  lemma_id TEXT NOT NULL,
  lang TEXT GENERATED ALWAYS AS (substr(lemma_id, 1, instr(lemma_id, ':') - 1)) STORED NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  fsrs TEXT NOT NULL CHECK (json_valid(fsrs)),
  due_at TEXT GENERATED ALWAYS AS (fsrs ->> '$.dueAt') STORED NOT NULL CHECK (due_at IS strftime('%Y-%m-%dT%H:%M:%fZ', due_at)),
  schedule_status TEXT GENERATED ALWAYS AS (fsrs ->> '$.scheduleStatus') STORED NOT NULL,
  scheduled_days REAL GENERATED ALWAYS AS (fsrs ->> '$.scheduledDays') STORED NOT NULL,
  first_reviewed_at TEXT CHECK (first_reviewed_at IS NULL OR first_reviewed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', first_reviewed_at)),
  data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data) AND json_type(data) = 'object')
) STRICT, WITHOUT ROWID;

CREATE INDEX card_due ON card (lang, due_at) WHERE active = 1 AND schedule_status != 'new';
CREATE INDEX card_first_reviewed ON card (lang, first_reviewed_at) WHERE first_reviewed_at IS NOT NULL;
CREATE INDEX card_lemma ON card (lemma_id, created_at);
CREATE INDEX card_listed ON card (lang, created_at);
CREATE INDEX card_new ON card (lang, created_at, lemma_id, kind DESC) WHERE active = 1 AND schedule_status = 'new';
CREATE UNIQUE INDEX card_blank ON card (data ->> '$.documentId', data ->> '$.blankStart') WHERE kind = 'cloze';
CREATE UNIQUE INDEX card_word ON card (lemma_id, kind) WHERE kind != 'cloze';

CREATE TRIGGER card_counted AFTER INSERT ON card BEGIN
  UPDATE row_count SET n = n + 1 WHERE name = 'card';
END;

CREATE TRIGGER card_uncounted AFTER DELETE ON card BEGIN
  UPDATE row_count SET n = n - 1 WHERE name = 'card';
END;

CREATE TABLE review (
  id TEXT NOT NULL PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES card (id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
  reviewed_at TEXT NOT NULL CHECK (reviewed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', reviewed_at))
) STRICT, WITHOUT ROWID;

CREATE INDEX review_card ON review (card_id, reviewed_at);
`;
