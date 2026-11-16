// A language's cards are listed newest first, all of them or one group's (CardsQuery).
// card_group is the card's group, as CARD_GROUPS names them, so one index seeks a group's
// cards in order where the kinds of words would be two seeks to merge. ADD COLUMN can only
// add a VIRTUAL generated column, which an index stores.
export const up = `ALTER TABLE card ADD COLUMN card_group TEXT GENERATED ALWAYS AS (iif(kind = 'cloze', 'forms', 'words')) VIRTUAL;
CREATE INDEX card_listed ON card (lang, created_at);
CREATE INDEX card_group_listed ON card (lang, card_group, created_at)`;

export const down = `DROP INDEX card_group_listed;
DROP INDEX card_listed;
ALTER TABLE card DROP COLUMN card_group`;
