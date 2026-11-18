import { iso } from "@skolia/util/checks";

export const up = `
ALTER TABLE reading_list RENAME TO reading_progress;
CREATE TABLE reading_list (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  texts_count INTEGER NOT NULL DEFAULT 0 CHECK(texts_count >= 0),
  added_at TEXT NOT NULL ${iso("added_at")}
) STRICT, WITHOUT ROWID;
CREATE TABLE reading_list_count (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  total INTEGER NOT NULL CHECK(total BETWEEN 0 AND 200)
) STRICT;
INSERT INTO reading_list_count VALUES (1, 0);
CREATE TRIGGER reading_list_added AFTER INSERT ON reading_list BEGIN
  UPDATE reading_list_count SET total = total + 1 WHERE id = 1;
END;
CREATE TRIGGER reading_list_removed AFTER DELETE ON reading_list BEGIN
  UPDATE reading_list_count SET total = total - 1 WHERE id = 1;
END;
INSERT INTO reading_list (id, name, added_at) VALUES ('to-read', 'To read', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE TABLE reading_list_text (
  list_id TEXT NOT NULL REFERENCES reading_list(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  added_at TEXT NOT NULL ${iso("added_at")},
  PRIMARY KEY (list_id, document_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX reading_list_text_page ON reading_list_text(list_id, added_at DESC, document_id DESC);
CREATE INDEX reading_list_text_lang ON reading_list_text(list_id, lang, added_at DESC, document_id DESC);
CREATE INDEX reading_list_text_document ON reading_list_text(document_id, list_id);
CREATE TRIGGER reading_list_text_added AFTER INSERT ON reading_list_text BEGIN
  UPDATE reading_list SET texts_count = texts_count + 1 WHERE id = new.list_id;
END;
CREATE TRIGGER reading_list_text_removed AFTER DELETE ON reading_list_text BEGIN
  UPDATE reading_list SET texts_count = texts_count - 1 WHERE id = old.list_id;
END;
-- Only the old To read queue becomes To read membership. All old statuses stay in reading_progress.
INSERT INTO reading_list_text (list_id, document_id, lang, added_at)
  SELECT 'to-read', document_id, lang, added_at FROM reading_progress WHERE status = 'to-read';
`;

export const down = `
DROP TABLE reading_list_text;
DROP TRIGGER reading_list_added;
DROP TRIGGER reading_list_removed;
DROP TABLE reading_list;
DROP TABLE reading_list_count;
ALTER TABLE reading_progress RENAME TO reading_list;
`;
