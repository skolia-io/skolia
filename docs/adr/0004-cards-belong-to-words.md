# 4. Cards belong to words

2026-11-24. Accepted. Supersedes 0003.

## Context

0003 dropped the `word` table: a word's state was its cards' (`card.active`), and a word was learning while one of its cards was. Choosing new cards then read every new card in the language. `freshCards` grouped all of a language's new word cards with a temp B-tree to find the first words not yet started, and `counts()` did that for each language every time Review loaded. New cloze cards were a group of their own, the forms, with their own allowance, and they read every new cloze card in the language.

## Decision

Words are rows again, and a card belongs to one or more of them. Counts kept on words and cards let each query that chooses what to review seek an index and stop.

- A word is learning or known. The state is the word's, not the card's: `PATCH /api/me/words/:lemmaId { state }` (`WordChange`) sets it, and returns 404 if the user has no such word. `PATCH /api/me/cards/:cardId` is gone.
- A card is learning, so reviewed, while one of its words is, and leaves Review only when all its words are known. Known hides cards of every kind, cloze cards included. Review's Known marks every word of the card known.
- Making a card adds its word, learning, if the user hadn't it, and doesn't change the state of a word they have. A known word stays known, with or without cards, until the user sets it learning again on purpose (skolia-io/tracking#93): opening a known word, or tapping it in learning mode, mustn't undo the mark.
- Answering a card starts every word of the card not yet started, at the server's time, in the same transaction as the review. Deleting a card doesn't un-start its words.
- The daily allowance, `newLemmasPerDay`, counts words started today, per language. A new card comes up once all its words are started, or once its unstarted words are all among today's picked words: the first N words being learnt and not yet started, by when they were added, where N is what's left of the allowance. So a card made for a word already started comes at once, without using the allowance.
- New cards come in the order they were made: `created_at`, then kind, recognition before production before cloze, then id.
- A cloze card is one of its word's cards like any other. The words and forms groups, the forms allowance (`newFormsPerDay`), the choice of one session or two (`formsWithWords`) and the cloze gate (a new cloze card waiting until its word was started) are gone.
- A word has at most one recognition and one production card. Cloze cards are one per blank, as before (`card_blank`).
- A word is kept, with its state and when it was started, when its last card is deleted.
- `GET /api/me/cards/counts` gives one `{ lang, due, new }` per language, `new` counting cards.

### Storage

User migration 0004 (`words`) drops `card` and `review` with their rows and makes them afresh. Nobody was using cards yet, and the old cards had no words to point at. It also drops `new_forms_per_day` and `forms_with_words` from `settings`.

```
word(lemma_id, lang, added_at, state, started_at, cards)
card(id, lang, kind, created_at, fsrs, …, data, unstarted_words, learning_words)
card_word(card_id, lemma_id, kind, created_at)
```

- `card_word` links cards and words, many to many, so a sentence card can later belong to several words. A card is still made for one word (`NewCard.lemmaId`). It copies the card's kind, with a foreign key on `(card_id, kind)` to `card (id, kind)`, and deleting a card deletes its links. The partial unique index `card_word_kind (lemma_id, kind) WHERE kind IN ('recognition', 'production')` keeps a word to one card of each of those kinds, and making one again returns it (200). It covers every `card_word` row of those kinds, so recognition and production stay kinds of one word. A card that belongs to several words, such as the planned sentence cards, is a kind of its own, with what it adds (the sentence) in `data` and its own unique index on that, as `card_blank` is for cloze cards (skolia-io/tracking#94).
- `card.lang` is a column, not generated from a lemma id, since a card can have several words.
- Triggers keep the counts. Adding or removing a `card_word` row changes the word's `cards` and the card's `unstarted_words` and `learning_words`. Changing a word's `started_at` or `state` changes the counts on its cards, found through `card_word`.
- The indexes the queries seek: `word_unstarted (lang, added_at) WHERE state = 'learning' AND started_at IS NULL AND cards > 0` for the picked words, `word_started (lang, started_at)` for the allowance, `card_ready (lang, created_at, kind DESC) WHERE schedule_status = 'new' AND unstarted_words = 0 AND learning_words > 0` for new cards whose words are all started, `card_due (lang, due_at) WHERE learning_words > 0 AND schedule_status != 'new'` for due cards, and `card_word_listed (lemma_id, created_at)` for a word's cards. The sorts left are over what's been chosen.

## Consequences

- An old reader breaks: `Card.lemmaId` and `ScheduledCard.lemmaId` are `lemmaIds`, `DueCard.entry` is `entries` (those of its words that the lexicon has), `Due.newLeft` is a number rather than `{ words, forms }`, `CardCounts` is `{ lang, due, new }` rather than `{ lang, words, forms }`, `GET /api/me/cards/due` has no `group`, `Settings` is `{ newLemmasPerDay }`, and `PATCH /api/me/cards/:cardId` is gone.
- Marking a word known is one request per word, not one per card.
- A word whose cards are all deleted keeps its row and stays started, so its cards made again come at once.
