// A card's kind's own data is card.data, a JSON object: {} for a word's recognition and
// production cards, the sentence and blank for a cloze card. cloze goes. card_blank keeps a
// text's blank to one cloze card and orders a text's cloze cards.
export const up = `ALTER TABLE card ADD COLUMN data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data) AND json_type(data) = 'object');
UPDATE card SET data = (
  SELECT json_object('documentId', document_id, 'sentence', sentence, 'sentenceStart', sentence_start,
    'blankStart', blank_start, 'blankEnd', blank_end, 'feats', json(feats), 'why', why)
  FROM cloze WHERE cloze.card_id = card.id
) WHERE kind = 'cloze';
DROP TABLE cloze;
CREATE UNIQUE INDEX card_blank ON card (data ->> '$.documentId', data ->> '$.blankStart') WHERE kind = 'cloze'`;

export const down = `DROP INDEX card_blank;
CREATE TABLE cloze (
  card_id TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'cloze' CHECK (kind = 'cloze'),
  document_id TEXT NOT NULL,
  sentence TEXT NOT NULL CHECK (sentence != ''),
  sentence_start INTEGER NOT NULL CHECK (sentence_start >= 0),
  blank_start INTEGER NOT NULL CHECK (blank_start >= sentence_start),
  blank_end INTEGER NOT NULL CHECK (blank_end > blank_start),
  feats TEXT NOT NULL CHECK (json_valid(feats) AND json_type(feats) = 'object'),
  why TEXT,
  UNIQUE (document_id, blank_start),
  FOREIGN KEY (card_id, kind) REFERENCES card (id, kind) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
INSERT INTO cloze (card_id, document_id, sentence, sentence_start, blank_start, blank_end, feats, why)
  SELECT id, data ->> '$.documentId', data ->> '$.sentence', data ->> '$.sentenceStart', data ->> '$.blankStart',
    data ->> '$.blankEnd', data -> '$.feats', data ->> '$.why'
  FROM card WHERE kind = 'cloze';
ALTER TABLE card DROP COLUMN data`;
