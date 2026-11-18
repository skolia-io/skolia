// Baseline for a new User object. The runner owns migration_log.
export const up = `CREATE TABLE "card" (
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

CREATE TABLE reading_list (
  document_id TEXT NOT NULL PRIMARY KEY,
  lang TEXT NOT NULL,
  status TEXT NOT NULL,
  added_at TEXT NOT NULL CHECK (added_at IS strftime('%Y-%m-%dT%H:%M:%fZ', added_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at))
) STRICT, WITHOUT ROWID;

CREATE INDEX reading_list_lang ON reading_list (lang, status, updated_at, document_id);

CREATE INDEX reading_list_status ON reading_list (status, updated_at, document_id);

CREATE TABLE reading_position (
  document_id TEXT NOT NULL PRIMARY KEY,
  sentence INTEGER NOT NULL CHECK (sentence >= 0),
  token INTEGER NOT NULL CHECK (token >= 0),
  at TEXT NOT NULL CHECK (at IS strftime('%Y-%m-%dT%H:%M:%fZ', at))
) STRICT, WITHOUT ROWID;

CREATE TABLE review (
  id TEXT NOT NULL PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES card (id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
  reviewed_at TEXT NOT NULL CHECK (reviewed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', reviewed_at))
) STRICT, WITHOUT ROWID;

CREATE INDEX review_card ON review (card_id, reviewed_at);

CREATE TABLE row_count (
  name TEXT NOT NULL PRIMARY KEY,
  n INTEGER NOT NULL CHECK (n >= 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  new_lemmas_per_day INTEGER NOT NULL CHECK (new_lemmas_per_day BETWEEN 0 AND 1000),
  new_forms_per_day INTEGER NOT NULL DEFAULT 20 CHECK (new_forms_per_day BETWEEN 0 AND 1000),
  forms_with_words INTEGER NOT NULL DEFAULT 1 CHECK (forms_with_words IN (0, 1))
) STRICT;


INSERT INTO row_count (name, n) VALUES ('card', 0);
INSERT INTO settings (id, new_lemmas_per_day) VALUES (1, 20);`;

export const down = `DROP TABLE review;
DROP TABLE card;
DROP TABLE reading_list;
DROP TABLE reading_position;
DROP TABLE row_count;
DROP TABLE settings;`;
