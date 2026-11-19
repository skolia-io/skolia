import { iso } from "@skolia/util/checks";

const reading = "00000000-0000-4000-8000-000000000001";
const finished = "00000000-0000-4000-8000-000000000002";

export const up = `
ALTER TABLE reading_list RENAME TO legacy_reading_list;
CREATE TABLE reading_list (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  documents_count INTEGER NOT NULL DEFAULT 0 CHECK(documents_count >= 0),
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
INSERT INTO reading_list (id, name, added_at) VALUES
  ('to-read', 'To read', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('${reading}', 'Reading now', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('${finished}', 'Finished', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE TABLE reading_list_document (
  list_id TEXT NOT NULL REFERENCES reading_list(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  added_at TEXT NOT NULL ${iso("added_at")},
  PRIMARY KEY (list_id, document_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX reading_list_document_page ON reading_list_document(list_id, added_at DESC, document_id DESC);
CREATE INDEX reading_list_document_lang ON reading_list_document(list_id, lang, added_at DESC, document_id DESC);
CREATE INDEX reading_list_document_document ON reading_list_document(document_id, list_id);
CREATE TRIGGER reading_list_document_added AFTER INSERT ON reading_list_document BEGIN
  UPDATE reading_list SET documents_count = documents_count + 1 WHERE id = new.list_id;
END;
CREATE TRIGGER reading_list_document_removed AFTER DELETE ON reading_list_document BEGIN
  UPDATE reading_list SET documents_count = documents_count - 1 WHERE id = old.list_id;
END;
INSERT INTO reading_list_document (list_id, document_id, lang, added_at)
  SELECT CASE status WHEN 'reading' THEN '${reading}' WHEN 'finished' THEN '${finished}' ELSE status END,
         document_id, lang, added_at
  FROM legacy_reading_list;
DROP TABLE legacy_reading_list;
`;

// The old schema can represent only one status per document, not custom lists.
// If several of the original lists contain it, use its newest membership.
export const down = `
CREATE TABLE legacy_reading_list (
  document_id TEXT NOT NULL PRIMARY KEY,
  lang TEXT NOT NULL,
  status TEXT NOT NULL,
  added_at TEXT NOT NULL ${iso("added_at")},
  updated_at TEXT NOT NULL ${iso("updated_at")}
) STRICT, WITHOUT ROWID;
INSERT INTO legacy_reading_list (document_id, lang, status, added_at, updated_at)
  SELECT document_id, lang, status, added_at, added_at FROM (
    SELECT document_id, lang, added_at,
           CASE list_id WHEN '${reading}' THEN 'reading' WHEN '${finished}' THEN 'finished' ELSE 'to-read' END AS status,
           row_number() OVER (PARTITION BY document_id ORDER BY added_at DESC, list_id) AS rank
    FROM reading_list_document WHERE list_id IN ('to-read', '${reading}', '${finished}')
  ) WHERE rank = 1;
DROP TABLE reading_list_document;
DROP TABLE reading_list;
DROP TABLE reading_list_count;
ALTER TABLE legacy_reading_list RENAME TO reading_list;
CREATE INDEX reading_list_lang ON reading_list (lang, status, updated_at, document_id);
CREATE INDEX reading_list_status ON reading_list (status, updated_at, document_id);
`;
