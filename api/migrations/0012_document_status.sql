-- A projection of the status blob for listings. No foreign key: a new import starts
-- its run before inserting the document, so its status can arrive first.
CREATE TABLE document_status (
  document_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  status TEXT NOT NULL CHECK (json_valid(status) AND json_type(status) IN ('object', 'null'))
) STRICT;
