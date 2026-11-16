// row_count counts cards of every kind, for MAX_CARDS, rather than cloze rows.
export const up = `DROP TRIGGER cloze_uncounted;
DROP TRIGGER cloze_counted;
DELETE FROM row_count WHERE name = 'cloze';
INSERT INTO row_count (name, n) SELECT 'card', count(*) FROM card;
CREATE TRIGGER card_counted AFTER INSERT ON card BEGIN
  UPDATE row_count SET n = n + 1 WHERE name = 'card';
END;
CREATE TRIGGER card_uncounted AFTER DELETE ON card BEGIN
  UPDATE row_count SET n = n - 1 WHERE name = 'card';
END`;

export const down = `DROP TRIGGER card_uncounted;
DROP TRIGGER card_counted;
DELETE FROM row_count WHERE name = 'card';
INSERT INTO row_count (name, n) SELECT 'cloze', count(*) FROM cloze;
CREATE TRIGGER cloze_counted AFTER INSERT ON cloze BEGIN
  UPDATE row_count SET n = n + 1 WHERE name = 'cloze';
END;
CREATE TRIGGER cloze_uncounted AFTER DELETE ON cloze BEGIN
  UPDATE row_count SET n = n - 1 WHERE name = 'cloze';
END`;
