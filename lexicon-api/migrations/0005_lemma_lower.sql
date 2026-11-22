-- Store Unicode lowercase from the export (SQLite lower only handles ASCII).
ALTER TABLE entry ADD COLUMN lemma_lower TEXT;
ALTER TABLE entry ADD COLUMN sense_count INTEGER;
CREATE INDEX entry_lemma_senses ON entry (lemma, version, sense_count DESC, lemma_id);
CREATE INDEX entry_lemma_lower ON entry (lemma_lower, version, sense_count DESC, lemma_id);
