"""Build the analysis blob from parser output. Language-neutral: anything language-specific
comes in through Language."""

import hashlib
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from itertools import accumulate
from typing import Protocol

from . import reconcile
from .parsed import ParsedSentence, ParsedToken, ParsedWord
from .schema import Blob, ExpressionDef, ExpressionMatch, Reading, Sentence, Token, Upos

SCHEMA = 2
"""The analysis blob's JSON shape. Documents keep their analysis until ingest redoes them,
so the reader has to read every schema still stored. Add a field as NotRequired, without
a bump. Bump it only when the shape changes, and keep reading the older schema in the
reader until a batch re-ingest retires it. 1 -> 2: each candidate has its own xpos, and
a token may have parser (both unused by the reader)."""

NO_LEMMA_ID: set[Upos] = {"PUNCT", "SYM"}


def utf16_offsets(text: str) -> list[int]:
    """The UTF-16 offset (a JavaScript string index) of each code point offset into text,
    its end included: a code point past the Basic Multilingual Plane (BMP) takes two units."""
    return list(accumulate((2 if ord(c) > 0xFFFF else 1 for c in text), initial=0))


def utf16_slice(text: str, start: int, end: int) -> str:
    """text[start:end] with start and end in UTF-16 code units, as the blob gives them."""
    return text.encode("utf-16-le")[2 * start : 2 * end].decode("utf-16-le")


class CandidateLookup(Protocol):
    def __call__(self, token: str, words: Sequence[str]) -> list[list[Reading]]:
        """All dictionary readings for each word of one surface token.

        words is how the parser split the token: one word normally, several for a fused
        word (zrobiłem -> zrobił, em). Returns one list of readings per word.
        """
        ...


type ExpressionGap = Callable[[Token], bool]
"""True for tokens expression matching should step over, e.g. the -em of dałem."""


def no_gaps(_token: Token) -> bool:
    return False


type EntryUpos = Callable[[Reading], Upos]
"""The part of speech of the lexicon entry a reading belongs to, for its lemma_id. Usually
the reading's own; Polish participles and gerunds belong to their verb."""


def own_upos(reading: Reading) -> Upos:
    return reading["upos"]


type Revise = Callable[[list[Token]], None]
"""Revises one sentence's built tokens in place, with the whole tree in view: Polish
corrects a case the verb rules out and says why each word has its case."""


def no_revision(_tokens: list[Token]) -> None:
    return None


@dataclass(frozen=True, kw_only=True)
class Language:
    """What building a blob needs to know about its language; the defaults add nothing to
    the parser's readings."""

    lang: str
    candidates: CandidateLookup | None = None
    """The dictionary's readings of each token: snap picks among them, and the reader
    offers them as alternatives."""
    snap: reconcile.Policy | None = None
    """Replaces the parser's reading with a candidate; None keeps the parser's."""
    expression_gap: ExpressionGap = no_gaps
    entry_upos: EntryUpos = own_upos
    revise: Revise = no_revision


def lemma_id(lang: str, lemma: str | None, upos: Upos) -> str | None:
    if not lemma or upos in NO_LEMMA_ID:
        return None
    return f"{lang}:{lemma}:{upos}"


def match_expressions(
    lemmas: Sequence[str | None],
    expressions: Iterable[ExpressionDef],
    gaps: Sequence[bool] | None = None,
) -> list[ExpressionMatch]:
    """Contiguous lemma-sequence matches, skipping tokens marked as gaps. Indices refer
    to the full token list, so a match can span a skipped token."""
    kept = [i for i in range(len(lemmas)) if not (gaps and gaps[i])]
    kept_lemmas = [(lemmas[i] or "").lower() for i in kept]
    found: list[ExpressionMatch] = []
    for expr in expressions:
        seq = [lemma.lower() for lemma in expr["lemmas"]]
        n = len(seq)
        found.extend(
            {"from": kept[i], "to": kept[i + n - 1], "id": expr["id"]}
            for i in range(len(kept) - n + 1)
            if kept_lemmas[i : i + n] == seq
        )
    return sorted(found, key=lambda m: (m["from"], m["to"]))


def parser_reading(word: ParsedWord) -> Reading:
    return {
        "lemma": word.lemma or word.text,
        "upos": word.upos,
        "xpos": word.xpos or "",
        "feats": word.feats,
    }


def token_reading(token: Token) -> Reading:
    """The reading a built token shows; before any change, the parser's."""
    return {
        "lemma": token["lemma"] or token["text"],
        "upos": token["upos"],
        "xpos": token["xpos"] or "",
        "feats": token["feats"],
    }


def choose_reading(
    word: ParsedWord, readings: list[Reading] | None, snap: reconcile.Policy | None
) -> Reading | None:
    """The candidate snap puts in place of the parser's reading, or None to keep it."""
    if snap is None or not readings or word.upos in NO_LEMMA_ID:
        return None
    return snap(parser_reading(word), readings)


def build_token(
    language: Language,
    units: Sequence[int],
    tok: ParsedToken,
    word: ParsedWord,
    readings: list[Reading] | None,
) -> Token:
    better = choose_reading(word, readings, language.snap)
    replaced = better is not None
    chosen = better or parser_reading(word)
    # parser_reading stands the text in for a missing lemma; that's no lemma to link by
    lemma = chosen["lemma"] if word.lemma or replaced else None
    entry: Token = {
        "start": units[tok.start],
        "end": units[tok.end],
        "text": word.text,
        "lemma": lemma,
        "lemma_id": lemma_id(language.lang, lemma, language.entry_upos(chosen)),
        "upos": chosen["upos"],
        "xpos": chosen["xpos"] or None,
        "feats": chosen["feats"],
        "head": word.head,
        "deprel": word.deprel,
    }
    if replaced:
        entry["parser"] = parser_reading(word)
    is_part_of_fused_word = len(tok.words) > 1
    if is_part_of_fused_word:
        entry["mwt"] = tok.text
    if readings is not None and word.upos not in NO_LEMMA_ID and len(readings) > 1:
        entry["candidates"] = readings
    return entry


def _readings(language: Language, tok: ParsedToken) -> list[list[Reading] | None]:
    """Each word's candidates, or None for each without any."""
    found = (
        language.candidates(tok.text, [w.text for w in tok.words]) if language.candidates else []
    )
    return list(found) or [None] * len(tok.words)


def build(
    sentences: Iterable[ParsedSentence],
    language: Language,
    *,
    analyzer: str,
    text: str,
    expressions: Iterable[ExpressionDef] = (),
) -> Blob:
    expression_list = list(expressions)
    units = utf16_offsets(text)
    built: list[Sentence] = []
    for sent in sentences:
        if not sent.tokens:
            # Nothing to show, and no offsets to give it
            continue
        tokens = [
            build_token(language, units, tok, word, readings)
            for tok in sent.tokens
            for word, readings in zip(tok.words, _readings(language, tok), strict=True)
        ]
        language.revise(tokens)
        lemmas = [t["lemma"] for t in tokens]
        gaps = [language.expression_gap(t) for t in tokens]
        built.append(
            {
                "start": units[sent.tokens[0].start],
                "end": units[sent.tokens[-1].end],
                "tokens": tokens,
                "expressions": match_expressions(lemmas, expression_list, gaps),
            }
        )
    return {
        "schema": SCHEMA,
        "analyzer": analyzer,
        "lang": language.lang,
        "hash": "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "sentences": built,
    }
