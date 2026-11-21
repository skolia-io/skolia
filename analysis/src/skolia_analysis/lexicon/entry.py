"""Build whole lexicon entries with borrowed senses, grammar, audio and paradigms."""

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import NamedTuple, cast

from ..lang.pl.walenty.model import Schema
from ..schema import Feats, Upos
from .schema import Entry, EntryParadigm, Paradigm, Pronunciation, Recording, Relation, Sense

type Frames = Callable[[str, Upos], list[Schema]]
"""A word's valency schemata, by lemma and part of speech."""

# For a lemma the lexicon has only under other parts of speech, the ones a dictionary
# files a word with this UPOS under, most likely first: an auxiliary is a verb to
# Wiktionary (must, AUX: the verb, not the noun a must). Any others come after, most
# senses first. Subordinators aren't listed: the most senses pick better than any fixed
# order (because is a conjunction, before and until prepositions).
CLOSEST_UPOS: dict[Upos, tuple[Upos, ...]] = {
    "AUX": ("VERB",),
    "PROPN": ("NOUN",),
    "NOUN": ("PROPN",),
    "DET": ("PRON", "ADJ"),
    "PRON": ("DET",),
    "PART": ("ADV",),
}

GRAMMAR_FEATURES = ("Aspect", "Gender", "Animacy")
"""Features that belong to a word rather than to one of its forms."""


def no_frames(_lemma: str, _upos: Upos) -> list[Schema]:
    return []


class Row(NamedTuple):
    """One entry as the build has it, before what's borrowed from other entries."""

    lemma_id: str
    lemma: str
    upos: Upos
    senses: list[Sense]
    relations: list[Relation]
    """Each with its target's lemma_id when the lexicon has the target."""
    paradigms: list[Paradigm]
    grammar: Feats


type BySpelling[T] = Mapping[str, Mapping[Upos, list[T]]]
"""By spelling, then part of speech in order: lead is /lɛd/ as a noun, /liːd/ as a verb."""


@dataclass(frozen=True)
class Lexicon:
    """What making an entry looks up besides its row."""

    rows: Mapping[str, Row] = field(default_factory=lambda: dict[str, Row]())
    """By lemma_id."""
    pronunciations: BySpelling[Pronunciation] = field(
        default_factory=lambda: dict[str, dict[Upos, list[Pronunciation]]]()
    )
    recordings: BySpelling[Recording] = field(
        default_factory=lambda: dict[str, dict[Upos, list[Recording]]]()
    )
    word_recordings: Mapping[str, list[Recording]] = field(
        default_factory=lambda: dict[str, list[Recording]]()
    )
    """Commons' recordings of a spelling, whatever its part of speech."""


class FeatsTable:
    """Assigns each distinct feature set an index in a list of them."""

    def __init__(self) -> None:
        self.table: list[Feats] = []
        self._index: dict[tuple[tuple[str, object], ...], int] = {}

    def __call__(self, feats: Feats) -> int:
        key = tuple(sorted(feats.items()))
        if key not in self._index:
            self._index[key] = len(self.table)
            self.table.append(feats)
        return self._index[key]


def make(lexicon: Lexicon, row: Row, frames: Frames, feats: FeatsTable) -> Entry:
    return {
        "lemma_id": row.lemma_id,
        "lemma": row.lemma,
        "upos": row.upos,
        "grammar": {**row.grammar, **_shared(row.paradigms)},
        "senses": row.senses or _borrowed(lexicon, row),
        "relations": row.relations,
        "pronunciations": pronounce(lexicon, row.lemma, row.upos),
        "recordings": record(lexicon, row.lemma, row.upos),
        "paradigms": [compact(p, feats) for p in row.paradigms],
        "frames": frames(row.lemma, row.upos),
    }


def _shared(paradigms: list[Paradigm]) -> Feats:
    """The GRAMMAR_FEATURES every form has with the same value: zgolić's Aspect=Perf."""
    forms = [form["feats"] for paradigm in paradigms for form in paradigm["forms"]]
    if not forms:
        return {}
    shared: dict[str, object] = {}
    for feature in GRAMMAR_FEATURES:
        values = {form.get(feature) for form in forms}
        if len(values) == 1 and (value := values.pop()) is not None:
            shared[feature] = value
    return cast(Feats, shared)


def _borrowed(lexicon: Lexicon, row: Row) -> list[Sense]:
    """For a word with no senses of its own, those of the words it's derived from: zgolić,
    which Wiktionary only lists as golić's perfective, means what golić does. Their
    examples and selectors are about the other word."""
    return [
        {"gloss": sense["gloss"], "tags": sense["tags"]}
        for relation in row.relations
        if relation["kind"] == "derived-from" and "lemma_id" in relation
        for target in [lexicon.rows.get(relation["lemma_id"])]
        if target is not None
        for sense in target.senses
    ]


def compact(paradigm: Paradigm, feats: FeatsTable) -> EntryParadigm:
    by_form: dict[str, list[int]] = {}
    for form in paradigm["forms"]:
        indices = by_form.setdefault(form["form"], [])
        index = feats(form["feats"])
        if index not in indices:
            indices.append(index)
    return {"homonym": paradigm["homonym"], "forms": list(by_form.items())}


def pronounce(lexicon: Lexicon, word: str, upos: Upos) -> list[Pronunciation]:
    found = _find(lexicon.pronunciations, word, upos)
    return lexicon.pronunciations[found[0]][found[1]] if found else []


def record(lexicon: Lexicon, word: str, upos: Upos) -> list[Recording]:
    """The recordings filed with the pronunciation pronounce picks: the noun lead, /lɛd/,
    has none of its own, and the verb's, /liːd/, would be wrong. Only a word without a
    pronunciation falls back by its recordings. Without any, Commons' recordings of the
    spelling, which only a language whose spelling gives the sound has (Polish)."""
    found = _find(lexicon.pronunciations, word, upos) or _find(lexicon.recordings, word, upos)
    if found and (heard := lexicon.recordings.get(found[0], {}).get(found[1], [])):
        return heard
    for spelling in dict.fromkeys([word, word.lower()]):
        if heard := lexicon.word_recordings.get(spelling):
            return heard
    return []


def _find[T](by_spelling: BySpelling[T], word: str, upos: Upos) -> tuple[str, Upos] | None:
    """The spelling and part of speech to look up. Falls back to the
    word lowercased (a sentence's first word), then the closest other part of speech (be
    as AUX is Wiktionary's verb)."""
    spellings = dict.fromkeys([word, word.lower()])
    for spelling in spellings:
        by_upos = by_spelling.get(spelling, {})
        if upos in by_upos:
            return spelling, upos
        for other in CLOSEST_UPOS.get(upos, ()):
            if other in by_upos:
                return spelling, other
    for spelling in spellings:
        if by_upos := by_spelling.get(spelling):
            return spelling, next(iter(by_upos))
    return None
