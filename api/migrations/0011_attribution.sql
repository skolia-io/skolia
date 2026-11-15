-- A credit (attribution): the licence something is under, its author and its source, as a
-- user claims them. Entries and annotations name one instead of carrying the three columns,
-- so the narration of a story's paragraphs is one row however many recordings share it. A
-- row is its content: the same credit given twice is one row (attribution_credit_idx), a
-- changed one is another, and a row is never updated. Nothing deletes a row no one names.
-- Licences are named with their version, as CC's credits must link the licence's own deed:
-- the existing ones were all taken for 4.0. That a public entry, or any annotation, needs a
-- licence that allows sharing it is the API's to check, since the licence is in this table.
CREATE TABLE attribution (
  id INTEGER PRIMARY KEY,
  licence TEXT NOT NULL CHECK (licence IN (
    'public-domain', 'cc0',
    'cc-by-4.0', 'cc-by-3.0', 'cc-by-sa-4.0', 'cc-by-sa-3.0', 'cc-by-nc-4.0', 'cc-by-nc-3.0',
    'cc-by-nc-sa-4.0', 'cc-by-nc-sa-3.0', 'cc-by-nd-4.0', 'cc-by-nd-3.0', 'cc-by-nc-nd-4.0', 'cc-by-nc-nd-3.0',
    'all-rights-reserved', 'unknown'
  )),
  author TEXT CHECK (author != ''),
  source TEXT CHECK (source GLOB 'http://?*' OR source GLOB 'https://?*')
) STRICT;

CREATE UNIQUE INDEX attribution_credit_idx ON attribution (licence, ifnull(author, ''), ifnull(source, ''));

INSERT INTO attribution (licence, author, source)
SELECT CASE WHEN licence GLOB 'cc-by*' THEN licence || '-4.0' ELSE licence END, author, source
FROM (
  SELECT licence, nullif(author, '') AS author, source FROM user_document
  UNION SELECT licence, nullif(author, ''), source FROM user_document_annotation
);

-- user_document's columns change, and SQLite can only drop a column a CHECK names by making
-- the table again, so user_document_tag and user_document_annotation, which reference it,
-- are made again too: renaming a table points its references at the new name, and
-- dropping the old one would delete its rows' tags and annotations.
DROP TRIGGER user_document_annotation_added;
DROP TRIGGER user_document_annotation_removed;
DROP INDEX user_document_user_imported_idx;
DROP INDEX user_document_public_imported_idx;
DROP INDEX user_document_document_idx;
DROP INDEX user_document_public_idx;
DROP INDEX user_document_tag_value_idx;
DROP INDEX user_document_annotation_start_idx;
ALTER TABLE user_document RENAME TO user_document_0010;
ALTER TABLE user_document_tag RENAME TO user_document_tag_0010;
ALTER TABLE user_document_annotation RENAME TO user_document_annotation_0010;

-- private: seen only by its user. A text is seen by anyone once one entry for it is public.
CREATE TABLE user_document (
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES document (id),
  title TEXT NOT NULL,
  imported_at TEXT NOT NULL CHECK (imported_at IS strftime('%Y-%m-%dT%H:%M:%fZ', imported_at)),
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  attribution_id INTEGER NOT NULL REFERENCES attribution (id),
  annotations_count INTEGER NOT NULL DEFAULT 0 CHECK (annotations_count >= 0),
  PRIMARY KEY (user_id, document_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE user_document_tag (
  user_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, document_id, kind),
  FOREIGN KEY (user_id, document_id) REFERENCES user_document (user_id, document_id) ON DELETE CASCADE,
  FOREIGN KEY (kind, value) REFERENCES tag (kind, value)
) STRICT, WITHOUT ROWID;

CREATE TABLE user_document_annotation (
  user_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  id TEXT NOT NULL,
  start INTEGER NOT NULL CHECK (start >= 0),
  "end" INTEGER NOT NULL CHECK ("end" > start),
  kind TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
  attribution_id INTEGER NOT NULL REFERENCES attribution (id),
  added_at TEXT NOT NULL CHECK (added_at IS strftime('%Y-%m-%dT%H:%M:%fZ', added_at)),
  PRIMARY KEY (user_id, document_id, id),
  FOREIGN KEY (user_id, document_id) REFERENCES user_document (user_id, document_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

INSERT INTO user_document (user_id, document_id, title, imported_at, visibility, attribution_id, annotations_count)
SELECT e.user_id, e.document_id, e.title, e.imported_at, e.visibility, a.id, e.annotations_count
FROM user_document_0010 e
JOIN attribution a ON a.licence = CASE WHEN e.licence GLOB 'cc-by*' THEN e.licence || '-4.0' ELSE e.licence END
  AND ifnull(a.author, '') = ifnull(e.author, '') AND ifnull(a.source, '') = ifnull(e.source, '');

INSERT INTO user_document_tag (user_id, document_id, kind, value)
SELECT user_id, document_id, kind, value FROM user_document_tag_0010;

INSERT INTO user_document_annotation (user_id, document_id, id, start, "end", kind, data, attribution_id, added_at)
SELECT n.user_id, n.document_id, n.id, n.start, n."end", n.kind, n.data, a.id, n.added_at
FROM user_document_annotation_0010 n
JOIN attribution a ON a.licence = CASE WHEN n.licence GLOB 'cc-by*' THEN n.licence || '-4.0' ELSE n.licence END
  AND ifnull(a.author, '') = ifnull(n.author, '') AND ifnull(a.source, '') = ifnull(n.source, '');

DROP TABLE user_document_annotation_0010;
DROP TABLE user_document_tag_0010;
DROP TABLE user_document_0010;

CREATE INDEX user_document_user_imported_idx ON user_document (user_id, imported_at DESC);
CREATE INDEX user_document_public_imported_idx ON user_document (imported_at DESC) WHERE visibility = 'public';
CREATE INDEX user_document_document_idx ON user_document (document_id);
-- The public entries in the documents list's order, by key, so a page of them reads no
-- private ones
CREATE INDEX user_document_public_idx ON user_document (user_id, document_id) WHERE visibility = 'public';
-- The entries with a tag, for a list narrowed to some values of a kind
CREATE INDEX user_document_tag_value_idx ON user_document_tag (kind, value, user_id, document_id);
-- An entry's annotations in order, a page at a time
CREATE INDEX user_document_annotation_start_idx ON user_document_annotation (user_id, document_id, start, id);

-- annotations_count, as 0010 keeps it
CREATE TRIGGER user_document_annotation_added AFTER INSERT ON user_document_annotation
BEGIN
  UPDATE user_document SET annotations_count = annotations_count + 1
  WHERE user_id = NEW.user_id AND document_id = NEW.document_id;
END;

CREATE TRIGGER user_document_annotation_removed AFTER DELETE ON user_document_annotation
BEGIN
  UPDATE user_document SET annotations_count = annotations_count - 1
  WHERE user_id = OLD.user_id AND document_id = OLD.document_id;
END;
