"""The lexicon on the server: one SQLite file per language, one row per lemma_id.

An entry keeps its senses (with their examples and selectors) and its paradigms (with
their forms) as JSON, in schema.py's Sense and Paradigm shapes. A relation names its
target's spelling, and its entry when the lexicon has one, and is indexed at both ends.
Pronunciations and recordings are by spelling, in tables of their own.
"""

import json
import sqlite3
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import NamedTuple, assert_never, cast

from ..schema import Feats, Upos
from .schema import (
    Accent,
    Example,
    Form,
    Paradigm,
    Pronunciation,
    Recording,
    Relation,
    RelationKind,
    Sense,
)

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE entry (
    lemma_id TEXT PRIMARY KEY,
    lemma TEXT NOT NULL,
    lemma_lower TEXT NOT NULL,
    upos TEXT NOT NULL,
    -- What every sense's selector says (pani: Fem), as UD features
    grammar TEXT NOT NULL CHECK (json_valid(grammar) AND json_type(grammar) = 'object'),
    -- schema.py's Sense and Paradigm, in order
    senses TEXT NOT NULL CHECK (json_valid(senses) AND json_type(senses) = 'array'),
    paradigms TEXT NOT NULL CHECK (json_valid(paradigms) AND json_type(paradigms) = 'array')
);
CREATE INDEX entry_lemma ON entry (lemma);
CREATE INDEX entry_lemma_lower ON entry (lemma_lower);
-- data: what the kind adds, {"aspect": "Perf"} or {"how": "diminutive"} (schema.py Relation).
-- target_id is NULL when no one entry has the target's spelling.
CREATE TABLE relation (
    source_id TEXT NOT NULL REFERENCES entry,
    ord INTEGER NOT NULL,
    target_lemma TEXT NOT NULL,
    target_id TEXT REFERENCES entry,
    kind TEXT NOT NULL,
    data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
    PRIMARY KEY (source_id, ord)
) WITHOUT ROWID;
CREATE INDEX relation_target_lemma ON relation (target_lemma, source_id, ord);
CREATE INDEX relation_target ON relation (target_id, source_id, ord);
CREATE TABLE pronunciation (
    word TEXT NOT NULL,
    upos TEXT NOT NULL,
    ord INTEGER NOT NULL,
    ipa TEXT NOT NULL,
    accents TEXT CHECK (accents IS NULL OR (json_valid(accents) AND json_type(accents) = 'array')),
    PRIMARY KEY (word, upos, ord)
) WITHOUT ROWID;
CREATE TABLE recording (
    id INTEGER PRIMARY KEY,
    word TEXT NOT NULL,
    upos TEXT,
    ord INTEGER NOT NULL,
    audio TEXT NOT NULL,
    mp3_url TEXT NOT NULL,
    tags TEXT CHECK (tags IS NULL OR (json_valid(tags) AND json_type(tags) = 'array'))
);
CREATE INDEX recording_word ON recording (word, upos, ord);
"""


class Edge(NamedTuple):
    """A relation row: data is its JSON object."""

    source_id: str
    ord: int
    target_lemma: str
    target_id: str | None
    kind: RelationKind
    data: str


class Row(NamedTuple):
    lemma_id: str
    lemma: str
    upos: Upos
    senses: list[Sense]
    relations: list[Relation]
    paradigms: list[Paradigm]
    grammar: Feats


class PronunciationRow(NamedTuple):
    word: str
    """As written, an inflected form or a lemma: psa, pies."""
    upos: Upos
    pronunciations: list[Pronunciation]
    recordings: list[Recording]


class VerbDerivative(NamedTuple):
    """A perfective verb Wiktionary lists among another's derived terms: zgolić under golić."""

    lang: str
    base: str
    derivative: str


@dataclass(frozen=True)
class Contents:
    """Everything a lexicon file holds."""

    meta: Mapping[str, str]
    rows: Sequence[Row] = ()
    pronunciations: Sequence[PronunciationRow] = ()
    word_recordings: Mapping[str, Sequence[Recording]] = field(
        default_factory=lambda: dict[str, Sequence[Recording]]()
    )
    """Commons' recordings by spelling (commons.py), for any part of speech."""
    derivatives: Sequence[VerbDerivative] = ()


def write(path: Path, contents: Contents) -> int:
    """Replaces the file at path; returns how many rows it wrote."""
    path.unlink(missing_ok=True)
    with sqlite3.connect(path) as db:
        db.executescript(SCHEMA)
        db.executemany("INSERT INTO meta VALUES (?, ?)", contents.meta.items())
        _write_entries(db, contents.rows)
        _write_relations(db, contents.rows)
        _write_derivatives(db, contents.derivatives)
        _write_pronunciations(db, contents.pronunciations)
        for word, recordings in sorted(contents.word_recordings.items()):
            _write_recordings(db, word, None, recordings)
    return len(contents.rows)


def _write_entries(db: sqlite3.Connection, rows: Iterable[Row]) -> None:
    db.executemany(
        "INSERT INTO entry VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            (
                row.lemma_id,
                row.lemma,
                row.lemma.lower(),
                row.upos,
                json.dumps(row.grammar),
                json.dumps([_sense(sense) for sense in row.senses]),
                json.dumps([_paradigm(paradigm) for paradigm in row.paradigms]),
            )
            for row in rows
        ),
    )


def _sense(sense: Sense) -> Sense:
    """Only Sense's keys, in its order, without an empty selector or example list."""
    stored: Sense = {"gloss": sense["gloss"], "tags": sense["tags"]}
    if when := sense.get("when"):
        stored["when"] = when
    if examples := sense.get("examples"):
        stored["examples"] = [_example(example) for example in examples]
    return stored


def _example(example: Example) -> Example:
    stored: Example = {"text": example["text"]}
    if (translation := example.get("translation")) is not None:
        stored["translation"] = translation
    return stored


def _paradigm(paradigm: Paradigm) -> Paradigm:
    forms: list[Form] = [
        {"form": form["form"], "xpos": form["xpos"], "feats": form["feats"]}
        for form in paradigm["forms"]
    ]
    return {"homonym": paradigm["homonym"], "forms": forms}


def _write_relations(db: sqlite3.Connection, rows: Sequence[Row]) -> None:
    """An aspect partner is a verb, given an entry of its own if Wiktionary has none."""
    edges = _edges(rows)
    for edge in edges:
        if edge.kind == "aspect-partner":
            _ensure_verb(db, edge.source_id.split(":", 1)[0], edge.target_lemma)
    db.executemany(
        """
        INSERT INTO relation (source_id, ord, target_lemma, target_id, kind, data)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        edges,
    )


def _edges(rows: Sequence[Row]) -> list[Edge]:
    """The rows' relations with their targets resolved: an aspect partner's is its verb;
    another's is the one entry with senses spelled like it, if there's one."""
    with_senses: dict[str, list[str]] = {}
    for row in rows:
        if row.senses:
            with_senses.setdefault(row.lemma, []).append(row.lemma_id)
    return [
        Edge(
            row.lemma_id,
            index,
            relation["lemma"],
            _target(row.lemma_id, relation, with_senses),
            relation["kind"],
            json.dumps(relation_data(relation), ensure_ascii=False),
        )
        for row in rows
        for index, relation in enumerate(row.relations)
    ]


def _target(source_id: str, relation: Relation, with_senses: Mapping[str, list[str]]) -> str | None:
    match relation["kind"]:
        case "aspect-partner":
            return _verb_id(source_id.split(":", 1)[0], relation["lemma"])
        case "derived-from" | "variant-of":
            matches = with_senses.get(relation["lemma"], [])
            return matches[0] if len(matches) == 1 else None
        case _:
            assert_never(relation["kind"])


def _write_pronunciations(db: sqlite3.Connection, said: Sequence[PronunciationRow]) -> None:
    db.executemany(
        "INSERT INTO pronunciation (word, upos, ord, ipa, accents) VALUES (?, ?, ?, ?, ?)",
        (
            (
                found.word,
                found.upos,
                index,
                pronunciation["ipa"],
                json.dumps(accents)
                if (accents := pronunciation.get("accents")) is not None
                else None,
            )
            for found in said
            for index, pronunciation in enumerate(found.pronunciations)
        ),
    )
    for found in said:
        _write_recordings(db, found.word, found.upos, found.recordings)


RELATION_KEYS = frozenset({"kind", "lemma", "lemma_id"})


def relation_data(relation: Relation) -> dict[str, object]:
    """What a relation's kind adds: the relation table's data column."""
    return {key: value for key, value in relation.items() if key not in RELATION_KEYS}


def make_relation(kind: str, lemma: str, target_id: str | None, data: str) -> Relation:
    relation = cast(Relation, {"kind": kind, "lemma": lemma, **json.loads(data)})
    if target_id is not None:
        relation["lemma_id"] = target_id
    return relation


def _verb_id(lang: str, lemma: str) -> str:
    return f"{lang}:{lemma}:VERB"


def _ensure_verb(db: sqlite3.Connection, lang: str, lemma: str) -> str:
    """A verb Wiktionary names only in another's entry (zgolić), without senses."""
    lemma_id = _verb_id(lang, lemma)
    db.execute(
        """
        INSERT INTO entry VALUES (?, ?, ?, 'VERB', '{}', '[]', '[]')
        ON CONFLICT (lemma_id) DO NOTHING
        """,
        (lemma_id, lemma, lemma.lower()),
    )
    return lemma_id


def _write_derivatives(db: sqlite3.Connection, derivatives: Iterable[VerbDerivative]) -> None:
    """Each derivative is derived-from its whole base, unless it says so already. Not from
    the sense Kaikki lists it under: it gives a page's derived terms to the sense before the
    list, so zgolić came under golić's "to down, to soak (to drink)", not "to shave"."""
    for lang, base, derivative in dict.fromkeys(derivatives):
        source_id = _ensure_verb(db, lang, derivative)
        target_id = _ensure_verb(db, lang, base)
        db.execute(
            """
            INSERT INTO relation (source_id, ord, target_lemma, target_id, kind, data)
            SELECT ?, coalesce(max(ord), -1) + 1, ?, ?, 'derived-from', ?
            FROM relation WHERE source_id = ?
            HAVING NOT EXISTS (
                SELECT 1 FROM relation
                WHERE source_id = ? AND target_id = ? AND kind = 'derived-from'
            )
            """,
            (
                source_id,
                base,
                target_id,
                json.dumps({"how": "perfective"}),
                source_id,
                source_id,
                target_id,
            ),
        )


def _write_recordings(
    db: sqlite3.Connection, word: str, upos: Upos | None, recordings: Iterable[Recording]
) -> None:
    for index, recording in enumerate(recordings):
        tags = recording.get("tags")
        db.execute(
            """
            INSERT INTO recording (word, upos, ord, audio, mp3_url, tags)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                word,
                upos,
                index,
                recording["audio"],
                recording["mp3_url"],
                json.dumps(tags) if tags is not None else None,
            ),
        )


class Lexicon:
    def __init__(self, path: Path) -> None:
        self._db = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)

    def meta(self) -> dict[str, str]:
        return dict(self._db.execute("SELECT key, value FROM meta").fetchall())

    def version(self) -> str:
        """The lexicon's version: its sources and their dates. The D1 export depends on it."""
        version = self.meta().get("version")
        if not version:
            raise ValueError("the lexicon has no version in its meta table")
        return version

    def get(self, lemma_id: str) -> Row | None:
        found = self._select("WHERE lemma_id = ?", lemma_id)
        return next(found, None)

    def by_lemma(self, lemma: str) -> list[Row]:
        """Every part of speech filed under this lemma, most senses first."""
        return sorted(self._select("WHERE lemma = ?", lemma), key=lambda r: -len(r.senses))

    def by_lowercase(self, lemma: str) -> list[Row]:
        rows = self._select("WHERE lemma_lower = ?", lemma.lower())
        return sorted(rows, key=lambda r: -len(r.senses))

    def incoming(self, lemma: str) -> Iterator[tuple[str, Relation]]:
        """Stored relations pointing to a spelling, even if it has no entry."""
        for source_id, target_id, kind, data in self._db.execute(
            """
            SELECT source_id, target_id, kind, data FROM relation
            WHERE target_lemma = ? ORDER BY source_id, ord
            """,
            (lemma,),
        ):
            yield source_id, make_relation(kind, lemma, target_id, data)

    def spoken_forms(self) -> Iterator[str]:
        for (word,) in self._db.execute(
            "SELECT word FROM pronunciation UNION SELECT word FROM recording"
        ):
            yield str(word)

    def pronunciations(self, word: str) -> dict[Upos, list[Pronunciation]]:
        """By part of speech: lead is /lɛd/ as a noun, /liːd/ as a verb."""
        result: dict[Upos, list[Pronunciation]] = {}
        for upos, ipa, accents in self._db.execute(
            "SELECT upos, ipa, accents FROM pronunciation WHERE word = ? ORDER BY upos, ord",
            (word,),
        ):
            pronunciation: Pronunciation = {"ipa": ipa}
            if accents is not None:
                pronunciation["accents"] = cast(list[Accent], json.loads(accents))
            result.setdefault(cast(Upos, upos), []).append(pronunciation)
        return result

    def recordings(self, word: str) -> dict[Upos, list[Recording]]:
        result: dict[Upos, list[Recording]] = {}
        for upos, recording in self._recordings(word, commons=False):
            result.setdefault(cast(Upos, upos), []).append(recording)
        return result

    def word_recordings(self, word: str) -> list[Recording]:
        """Commons' recordings of the spelling, whatever its part of speech."""
        return [recording for _, recording in self._recordings(word, commons=True)]

    def _recordings(self, word: str, *, commons: bool) -> Iterator[tuple[Upos | None, Recording]]:
        condition = "IS NULL" if commons else "IS NOT NULL"
        for upos, audio, mp3_url, tags in self._db.execute(
            f"""
            SELECT upos, audio, mp3_url, tags FROM recording
            WHERE word = ? AND upos {condition} ORDER BY upos, ord
            """,
            (word,),
        ):
            recording: Recording = {"audio": audio, "mp3_url": mp3_url}
            if tags is not None:
                recording["tags"] = cast(list[str], json.loads(tags))
            yield upos, recording

    def rows(self) -> Iterator[Row]:
        """Every entry, by lemma_id."""
        return self._select("ORDER BY lemma_id")

    def _select(self, where: str, *values: str) -> Iterator[Row]:
        for lemma_id, lemma, upos, grammar, senses, paradigms in self._db.execute(
            f"SELECT lemma_id, lemma, upos, grammar, senses, paradigms FROM entry {where}",
            values,
        ):
            yield Row(
                lemma_id,
                lemma,
                upos,
                cast(list[Sense], json.loads(senses)),
                list(self._relations(lemma_id)),
                cast(list[Paradigm], json.loads(paradigms)),
                cast(Feats, json.loads(grammar)),
            )

    def edges(self) -> Iterator[Edge]:
        """Every relation as stored, by source."""
        for row in self._db.execute(
            """
            SELECT source_id, ord, target_lemma, target_id, kind, data FROM relation
            ORDER BY source_id, ord
            """
        ):
            yield Edge(*row)

    def _relations(self, lemma_id: str) -> Iterator[Relation]:
        for target_lemma, target_id, kind, data in self._db.execute(
            """
            SELECT target_lemma, target_id, kind, data FROM relation
            WHERE source_id = ? ORDER BY ord
            """,
            (lemma_id,),
        ):
            yield make_relation(kind, target_lemma, target_id, data)
