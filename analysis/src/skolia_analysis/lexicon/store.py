"""A language's lexicon file: the lexicon Worker's D1 lexicon (LEXICON_{LANG}) as a SQLite file,
one version's rows in D1's own schema, made by applying lexicon/migrations in order, plus a
meta table with the language, version and attribution. infra/load-lexicon.py copies the
rows into D1.

Each entry's data is the whole Entry the Worker serves (lexicon/entry.py), its paradigms'
forms ["psa", [1, 3]]: psa is feature sets 1 and 3, genitive and accusative singular. Set
1 is the rows (1, Case, Gen), (1, Number, Sing), ... in featureset. The relation rows are
the lexicon's graph, for finding what points at a word. form_pronunciation has each
spelling's pronunciations and recordings by part of speech, and with upos "" Commons'
recordings of the spelling.
"""

import json
import sqlite3
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import NamedTuple, cast

from ..schema import Feats, Upos
from .schema import Entry, Relation, RelationKind


class EntryRow(NamedTuple):
    lemma_id: str
    lemma: str
    upos: Upos
    data: str
    """The Entry as JSON."""
    sense_count: int
    """Its own senses, not those it borrows: lookups fall back past an entry without any."""


class Edge(NamedTuple):
    """A relation row: data is what its kind adds, as JSON."""

    source_id: str
    ord: int
    target_lemma: str
    target_id: str | None
    kind: RelationKind
    data: str


class AudioRow(NamedTuple):
    form: str
    upos: Upos | None
    """None for Commons' recordings of the spelling, whatever its part of speech."""
    data: str
    """{"pronunciations": [...], "recordings": [...]} as JSON."""


@dataclass(frozen=True)
class Contents:
    """Everything a lexicon file holds."""

    meta: Mapping[str, str]
    """lang, version and attribution."""
    entries: Sequence[EntryRow] = ()
    edges: Sequence[Edge] = ()
    featuresets: Sequence[Feats] = ()
    """The feature sets paradigms point into, by id."""
    audio: Sequence[AudioRow] = ()


def write(path: Path, migrations: Path, contents: Contents) -> None:
    """Replaces the file at path. migrations is lexicon/migrations."""
    version = contents.meta["version"]
    path.unlink(missing_ok=True)
    with sqlite3.connect(path) as db:
        for migration in sorted(migrations.glob("*.sql")):
            db.executescript(migration.read_text())
        db.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.executemany("INSERT INTO meta VALUES (?, ?)", contents.meta.items())
        db.executemany(
            "INSERT INTO entry "
            "(lemma_id, version, lemma, upos, data, lemma_lower, sense_count) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                (e.lemma_id, version, e.lemma, e.upos, e.data, e.lemma.lower(), e.sense_count)
                for e in contents.entries
            ),
        )
        db.executemany(
            """
            INSERT INTO relation (source_id, version, ord, target_lemma, target_id, kind, data)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (e.source_id, version, e.ord, e.target_lemma, e.target_id, e.kind, e.data)
                for e in contents.edges
            ),
        )
        db.executemany(
            "INSERT INTO featureset (version, id, feature, value) VALUES (?, ?, ?, ?)",
            (
                (version, i, k, str(v))
                for i, feats in enumerate(contents.featuresets)
                for k, v in feats.items()
            ),
        )
        db.executemany(
            "INSERT INTO form_pronunciation (form, upos, version, data) VALUES (?, ?, ?, ?)",
            ((a.form, a.upos or "", version, a.data) for a in contents.audio),
        )


def to_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


RELATION_KEYS = frozenset({"kind", "lemma", "lemma_id"})


def relation_data(relation: Relation) -> dict[str, object]:
    """What a relation's kind adds: the relation table's data column."""
    return {key: value for key, value in relation.items() if key not in RELATION_KEYS}


def make_relation(kind: str, lemma: str, target_id: str | None, data: str) -> Relation:
    relation = cast(Relation, {"kind": kind, "lemma": lemma, **json.loads(data)})
    if target_id is not None:
        relation["lemma_id"] = target_id
    return relation


class Lexicon:
    """Reads a lexicon file, for looking words up by hand (skolia-lexicon) and evaluations.
    Lookups by lemma find what the Worker's do: entries with senses of their own, most
    first."""

    def __init__(self, path: Path) -> None:
        self._db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)

    def meta(self) -> dict[str, str]:
        return dict(self._db.execute("SELECT key, value FROM meta").fetchall())

    def get(self, lemma_id: str) -> Entry | None:
        found = self._db.execute("SELECT data FROM entry WHERE lemma_id = ?", (lemma_id,))
        return next((cast(Entry, json.loads(data)) for (data,) in found), None)

    def has_senses(self, lemma_id: str) -> bool:
        found = self._db.execute(
            "SELECT 1 FROM entry WHERE lemma_id = ? AND sense_count > 0", (lemma_id,)
        )
        return found.fetchone() is not None

    def by_lemma(self, lemma: str) -> list[Entry]:
        """Every part of speech filed under this lemma, with or without senses."""
        return self._entries("lemma = ?", lemma)

    def with_senses(self, lemma: str) -> list[Entry]:
        return self._entries("lemma = ? AND sense_count > 0", lemma)

    def lowercase_with_senses(self, lemma: str) -> list[Entry]:
        return self._entries("lemma_lower = ? AND sense_count > 0", lemma.lower())

    def incoming(self, lemma: str) -> Iterable[tuple[str, Relation]]:
        """Stored relations pointing to a spelling, even if it has no entry."""
        for source_id, target_id, kind, data in self._db.execute(
            """
            SELECT source_id, target_id, kind, data FROM relation
            WHERE target_lemma = ? ORDER BY source_id, ord
            """,
            (lemma,),
        ):
            yield source_id, make_relation(kind, lemma, target_id, data)

    def _entries(self, where: str, value: str) -> list[Entry]:
        found = self._db.execute(
            f"SELECT data FROM entry WHERE {where} ORDER BY sense_count DESC, lemma_id",
            (value,),
        )
        return [cast(Entry, json.loads(data)) for (data,) in found]
