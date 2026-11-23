CREATE TABLE card (
  id TEXT NOT NULL PRIMARY KEY,
  lang TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  fsrs TEXT NOT NULL CHECK (json_valid(fsrs)),
  due_at TEXT GENERATED ALWAYS AS (fsrs ->> '$.dueAt') STORED NOT NULL CHECK (due_at IS strftime('%Y-%m-%dT%H:%M:%fZ', due_at)),
  schedule_status TEXT GENERATED ALWAYS AS (fsrs ->> '$.scheduleStatus') STORED NOT NULL,
  scheduled_days REAL GENERATED ALWAYS AS (fsrs ->> '$.scheduledDays') STORED NOT NULL,
  data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data) AND json_type(data) = 'object'),
  unstarted_words INTEGER NOT NULL DEFAULT 0 CHECK (unstarted_words >= 0),
  learning_words INTEGER NOT NULL DEFAULT 0 CHECK (learning_words >= 0),
  UNIQUE (id, kind)
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX card_blank ON card (data ->> '$.documentId', data ->> '$.blankStart') WHERE kind = 'cloze';

CREATE INDEX card_due ON card (lang, due_at) WHERE learning_words > 0 AND schedule_status != 'new';

CREATE INDEX card_listed ON card (lang, created_at);

CREATE INDEX card_ready ON card (lang, created_at, kind DESC) WHERE schedule_status = 'new' AND unstarted_words = 0 AND learning_words > 0;

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
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  PRIMARY KEY (lemma_id, card_id),
  FOREIGN KEY (card_id, kind) REFERENCES card (id, kind) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX card_word_card ON card_word (card_id, lemma_id);

CREATE UNIQUE INDEX card_word_kind ON card_word (lemma_id, kind) WHERE kind IN ('recognition', 'production');

CREATE INDEX card_word_listed ON card_word (lemma_id, created_at);

CREATE TRIGGER card_word_added AFTER INSERT ON card_word BEGIN
  UPDATE word SET cards = cards + 1 WHERE lemma_id = NEW.lemma_id;
  UPDATE card SET
    unstarted_words = unstarted_words + 1 * (SELECT started_at IS NULL FROM word WHERE lemma_id = NEW.lemma_id),
    learning_words = learning_words + 1 * (SELECT state = 'learning' FROM word WHERE lemma_id = NEW.lemma_id)
  WHERE id = NEW.card_id;
END;

CREATE TRIGGER card_word_removed AFTER DELETE ON card_word BEGIN
  UPDATE word SET cards = cards + -1 WHERE lemma_id = OLD.lemma_id;
  UPDATE card SET
    unstarted_words = unstarted_words + -1 * (SELECT started_at IS NULL FROM word WHERE lemma_id = OLD.lemma_id),
    learning_words = learning_words + -1 * (SELECT state = 'learning' FROM word WHERE lemma_id = OLD.lemma_id)
  WHERE id = OLD.card_id;
END;

CREATE TABLE migration_log (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          version INTEGER NOT NULL CHECK (version > 0),
          name TEXT NOT NULL,
          direction TEXT NOT NULL CHECK (direction IN ('up', 'down')),
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL CHECK (applied_at IS strftime('%Y-%m-%dT%H:%M:%fZ', applied_at)),
          down TEXT CHECK (direction = 'up' OR down IS NULL)
        ) STRICT;

CREATE TRIGGER migration_log_no_delete BEFORE DELETE ON migration_log
          BEGIN SELECT RAISE(ABORT, 'migration_log is append-only'); END;

CREATE TRIGGER migration_log_no_update BEFORE UPDATE ON migration_log
          BEGIN SELECT RAISE(ABORT, 'migration_log is append-only'); END;

CREATE TABLE rate_window (
  action TEXT NOT NULL PRIMARY KEY,
  started_at TEXT NOT NULL CHECK (started_at IS strftime('%Y-%m-%dT%H:%M:%fZ', started_at)),
  count INTEGER NOT NULL CHECK (count >= 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE reading_list (
  id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id > 0),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  documents_count INTEGER NOT NULL DEFAULT 0 CHECK(documents_count >= 0),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at))
) STRICT;

CREATE TRIGGER reading_list_added AFTER INSERT ON reading_list BEGIN
  UPDATE reading_list_count SET total = total + 1 WHERE id = 1;
END;

CREATE TRIGGER reading_list_removed AFTER DELETE ON reading_list BEGIN
  UPDATE reading_list_count SET total = total - 1 WHERE id = 1;
END;

CREATE TABLE reading_list_count (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  total INTEGER NOT NULL CHECK(total BETWEEN 0 AND 200)
) STRICT;

CREATE TABLE reading_list_document (
  list_id INTEGER NOT NULL REFERENCES reading_list(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  PRIMARY KEY (list_id, document_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX reading_list_document_document ON reading_list_document(document_id, list_id);

CREATE INDEX reading_list_document_lang ON reading_list_document(list_id, lang, created_at DESC, document_id DESC);

CREATE INDEX reading_list_document_page ON reading_list_document(list_id, created_at DESC, document_id DESC);

CREATE TRIGGER reading_list_document_added AFTER INSERT ON reading_list_document BEGIN
  UPDATE reading_list SET documents_count = documents_count + 1 WHERE id = new.list_id;
END;

CREATE TRIGGER reading_list_document_removed AFTER DELETE ON reading_list_document BEGIN
  UPDATE reading_list SET documents_count = documents_count - 1 WHERE id = old.list_id;
END;

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
  new_lemmas_per_day INTEGER NOT NULL CHECK (new_lemmas_per_day BETWEEN 0 AND 1000)) STRICT;

CREATE TABLE word (
  lemma_id TEXT NOT NULL PRIMARY KEY,
  lang TEXT GENERATED ALWAYS AS (substr(lemma_id, 1, instr(lemma_id, ':') - 1)) STORED NOT NULL,
  added_at TEXT NOT NULL CHECK (added_at IS strftime('%Y-%m-%dT%H:%M:%fZ', added_at)),
  state TEXT NOT NULL,
  started_at TEXT CHECK (started_at IS NULL OR started_at IS strftime('%Y-%m-%dT%H:%M:%fZ', started_at)),
  cards INTEGER NOT NULL DEFAULT 0 CHECK (cards >= 0)
) STRICT, WITHOUT ROWID;

CREATE INDEX word_started ON word (lang, started_at) WHERE started_at IS NOT NULL;

CREATE INDEX word_unstarted ON word (lang, added_at) WHERE state = 'learning' AND started_at IS NULL AND cards > 0;

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
