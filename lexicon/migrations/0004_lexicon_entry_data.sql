-- An entry is the whole Entry the lexicon Worker serves, built by analysis's lexicon/entry.py: its
-- senses resolved (zgolić's from golić), grammar, pronunciations and paradigms. A relation
-- names its target's spelling, and its entry when the lexicon has one; data is what its
-- kind adds, {"aspect": "Perf"} or {"how": "diminutive"}. Every version is dropped; the next
-- load fills the tables again.
DROP TABLE relation;
DROP TABLE entry;
DELETE FROM featureset;
DELETE FROM loaded;

CREATE TABLE entry (
  lemma_id TEXT NOT NULL,
  version TEXT NOT NULL,
  lemma TEXT NOT NULL,
  upos TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
  PRIMARY KEY (lemma_id, version)
) STRICT, WITHOUT ROWID;
CREATE INDEX entry_lemma ON entry (lemma, version);

CREATE TABLE relation (
  source_id TEXT NOT NULL,
  version TEXT NOT NULL,
  ord INTEGER NOT NULL,
  target_lemma TEXT NOT NULL,
  target_id TEXT,
  kind TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
  PRIMARY KEY (source_id, version, ord)
) STRICT, WITHOUT ROWID;
CREATE INDEX relation_target ON relation (target_id, version);
