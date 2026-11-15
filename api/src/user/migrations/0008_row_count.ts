// How many rows a table has, kept by triggers, so a cap is one lookup rather than a
// count(*) over the table. A card's cloze row goes by the card's ON DELETE CASCADE, which
// fires cloze's delete trigger too. One row per counted table: cloze for MAX_CLOZES.
export const up = `CREATE TABLE row_count (
  name TEXT NOT NULL PRIMARY KEY,
  n INTEGER NOT NULL CHECK (n >= 0)
) STRICT, WITHOUT ROWID;
INSERT INTO row_count (name, n) SELECT 'cloze', count(*) FROM cloze;
CREATE TRIGGER cloze_counted AFTER INSERT ON cloze BEGIN
  UPDATE row_count SET n = n + 1 WHERE name = 'cloze';
END;
CREATE TRIGGER cloze_uncounted AFTER DELETE ON cloze BEGIN
  UPDATE row_count SET n = n - 1 WHERE name = 'cloze';
END`;

export const down = `DROP TRIGGER cloze_uncounted;
DROP TRIGGER cloze_counted;
DROP TABLE row_count`;
