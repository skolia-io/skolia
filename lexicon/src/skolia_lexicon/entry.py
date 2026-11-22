"""Build whole lexicon entries with borrowed senses, grammar and paradigms."""

from collections.abc import Callable, Mapping
from typing import NamedTuple, cast

from skolia.pl.walenty.model import Schema
from skolia.ud import Feats, Upos

from .schema import EntryParadigm, Paradigm, Relation, Sense, StoredEntry

type Frames = Callable[[str, Upos], list[Schema]]
"""A word's valency schemata, by lemma and part of speech."""

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


def make(rows: Mapping[str, Row], row: Row, frames: Frames, feats: FeatsTable) -> StoredEntry:
    return {
        "lemma_id": row.lemma_id,
        "lemma": row.lemma,
        "upos": row.upos,
        "grammar": {**row.grammar, **_shared(row.paradigms)},
        "senses": row.senses or _borrowed(rows, row),
        "relations": row.relations,
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


def _borrowed(rows: Mapping[str, Row], row: Row) -> list[Sense]:
    """For a word with no senses of its own, those of the words it's derived from: zgolić,
    which Wiktionary only lists as golić's perfective, means what golić does. Their
    examples and selectors are about the other word."""
    return [
        {"gloss": sense["gloss"], "tags": sense["tags"]}
        for relation in row.relations
        if relation["kind"] == "derived-from" and "lemma_id" in relation
        for target in [rows.get(relation["lemma_id"])]
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
