// Preserve list memberships when upgrading a preview already on 0002.
function rename(from: string, to: string, fromCount: string, toCount: string): string {
  return `
DROP TRIGGER ${from}_added;
DROP TRIGGER ${from}_removed;
DROP INDEX ${from}_page;
DROP INDEX ${from}_lang;
DROP INDEX ${from}_document;
ALTER TABLE ${from} RENAME TO ${to};
ALTER TABLE reading_list RENAME COLUMN ${fromCount} TO ${toCount};
CREATE INDEX ${to}_page ON ${to}(list_id, added_at DESC, document_id DESC);
CREATE INDEX ${to}_lang ON ${to}(list_id, lang, added_at DESC, document_id DESC);
CREATE INDEX ${to}_document ON ${to}(document_id, list_id);
CREATE TRIGGER ${to}_added AFTER INSERT ON ${to} BEGIN
  UPDATE reading_list SET ${toCount} = ${toCount} + 1 WHERE id = new.list_id;
END;
CREATE TRIGGER ${to}_removed AFTER DELETE ON ${to} BEGIN
  UPDATE reading_list SET ${toCount} = ${toCount} - 1 WHERE id = old.list_id;
END;
`;
}

export const up = rename("reading_list_text", "reading_list_document", "texts_count", "documents_count");
export const down = rename("reading_list_document", "reading_list_text", "documents_count", "texts_count");
