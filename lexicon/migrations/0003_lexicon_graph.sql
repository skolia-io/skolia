-- The lexicon as a graph, as analysis's lexicon/store.py builds it: an entry is a node, and
-- relations are rows between nodes rather than JSON on the entry. A node with no upos is
-- a spelling a relation points at that the lexicon has no entry for. Every version is
-- dropped; the next load fills the tables again.
DROP TABLE entry;
DELETE FROM featureset;
DELETE FROM loaded;

CREATE TABLE entry (
  lemma_id TEXT NOT NULL,
  version TEXT NOT NULL,
  lemma TEXT NOT NULL,
  upos TEXT,
  senses TEXT NOT NULL,
  pronunciations TEXT NOT NULL,
  paradigms TEXT NOT NULL,
  PRIMARY KEY (lemma_id, version)
) STRICT, WITHOUT ROWID;
CREATE INDEX entry_lemma ON entry (lemma, version);

-- zgolić -> golić, derived-from, "perfective derivative", target_senses [4]: zgolić is the
-- perfective of golić's fifth sense. target_senses NULL: the whole target.
CREATE TABLE relation (
  source_id TEXT NOT NULL,
  version TEXT NOT NULL,
  ord INTEGER NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  note TEXT,
  target_senses TEXT CHECK (
    target_senses IS NULL OR (json_valid(target_senses) AND json_type(target_senses) = 'array')
  ),
  PRIMARY KEY (source_id, version, ord)
) STRICT, WITHOUT ROWID;
CREATE INDEX relation_target ON relation (target_id, version);
