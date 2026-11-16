# 3. Cards own words

2026-11-16. Accepted. Replaces the words API of 0001 and the word statuses in 0002.

## Context

A user's words (0001) had a status, active, known or ignored, and the cards followed it: active made the word's recognition and production cards, any other status took all of its cards out of reviews, and making a cloze card made its word active (0002). So cards were made in two places, `PUT /api/me/words/:lemmaId` for a word's cards and `POST /api/me/cards` for cloze cards, and a word's state lived in two tables kept in step.

## Decision

What the user knows of a word is its cards. The `word` table and `/api/me/words` go, and the cards API is the only one that makes or changes a card:

```
GET    /api/me/cards?lang= | ?lemmaId= | ?documentId=   a language's or a word's cards, newest first, or a text's
POST   /api/me/cards                                     { kind: recognition | production, lemmaId } or a cloze card
PATCH  /api/me/cards/:cardId                             { state: learning | known }
DELETE /api/me/cards/:cardId                             with its reviews
```

- A card is learning, so reviewed, or known, so not. A word is new with no cards, learning while one of its cards is, and known when all of them are.
- A word has at most one recognition and one production card; making one again returns it (200). Nothing makes a card as a side effect: the word sheet's + makes the word's two cards and its cloze card.
- Known is per card. Review's Known marks all the word's cards, cloze cards too, as the word status did. The word sheet's tick deletes the word's cards, asking first if any has been reviewed.
- A new cloze card waits until its word has had a review, as before, but only while the word has cards being learnt: a cloze card on its own, or for a word whose cards are known, isn't held back.
- Ignored is gone. Nothing used it beyond hiding the word sheet's cloze card, and the word sheet doesn't offer names, numbers or symbols.

### Storage

`card.active` is the card's state, 1 learning and 0 known, so the review queries keep their partial indexes. User migration 10 (`cards_own_words`) gives every word known or ignored that has no cards a known recognition card, new, with the word's `updated_at` for its time, so the mark survives; an ignored word's cards are known. Then it drops `word`, and `card_lemma` gains `created_at` for a word's cards newest first. Down makes a word for each lemma with cards, active if one is learning and known otherwise.

## Consequences

- An old reader breaks: `/api/me/words` is gone, and `POST /api/me/cards` with a cloze card no longer makes the word's cards.
- Marking a word known is one request per card, not one per word, so a failure part way leaves some cards known.
- A word known without studying has a card it was never shown.
