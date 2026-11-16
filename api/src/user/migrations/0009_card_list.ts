// A language's cards are listed newest first (CardsQuery).
export const up = `CREATE INDEX card_listed ON card (lang, created_at)`;

export const down = `DROP INDEX card_listed`;
